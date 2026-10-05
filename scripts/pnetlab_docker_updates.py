#!/usr/bin/env python3
"""Root-only, digest pinned RSPnet image jobs. Never changes a container."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

STATE = Path('/var/lib/pnetlab/docker-updates')
# Separate shipped seed: the web catalog's parent is writable by www-data.
# Regenerate this root-owned allowlist when adding managed catalog entries.
CATALOG = Path(__file__).with_name('pnetlab-docker-managed.json')
RELEASES = Path(__file__).with_name('pnetlab-docker-releases.json')
LABS = Path('/opt/unetlab/labs')
DOCKER = ['docker', '-H=unix:///var/run/docker.sock']
VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
ACCEPT = ', '.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])
DOCKER_BLOB_HOSTS = {'production.cloudflare.docker.com', 'production.cloudfront.docker.com'}

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def version_key(value):
    return tuple(int(x or 0) for x in VERSION.fullmatch(value).groups())

def read(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return default

def atomic(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    trusted(path.parent)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    with open(temp, 'x') as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)

@contextlib.contextmanager
def lock(name):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    trusted(STATE)
    trusted(STATE.parent)
    with open(STATE / (name + '.lock'), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield

def trusted(path):
    path = path.absolute()
    for target in (path, *path.parents):
        info = target.stat()
        if target.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted Docker update path: ' + str(target))

def catalog():
    trusted(CATALOG)
    trusted(CATALOG.parent)
    result = {}
    for row in read(CATALOG, {}).get('nodes', []):
        alias = row.get('device_version', '')
        match = re.fullmatch(r'(pnet-[a-z0-9-]+):([0-9]+\.[0-9]+)', alias)
        if not match:
            continue
        family = match[1]
        repo = 'rspnet/' + family
        if row.get('managed_repository') != repo or row.get('managed_platform') != 'linux/amd64':
            continue
        result[str(row['device_id'])] = {'repository': repo, 'family': family, 'alias': alias}
    return result

def command(args, timeout=120):
    result = subprocess.run(DOCKER + args, capture_output=True, text=True, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'})
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-2000:] or 'Docker operation failed')
    return result.stdout

def inspect(ref):
    try:
        return json.loads(command(['image', 'inspect', ref]))[0]
    except RuntimeError as error:
        if 'No such image' in str(error) or 'not found' in str(error):
            return None
        raise

def images():
    ids = command(['image', 'ls', '-aq', '--no-trunc']).split()
    result = []
    for start in range(0, len(ids), 50):
        result.extend(json.loads(command(['image', 'inspect'] + list(dict.fromkeys(ids[start:start+50])))))
    return result

class Registry:
    def __init__(self, repository):
        self.repository = repository
        self.token = None

    def request(self, url, headers=None, blob=False):
        # Every network destination is constructed here, never from registry links.
        if not url.startswith(('https://registry-1.docker.io/', 'https://auth.docker.io/')):
            raise ValueError('Registry host rejected')
        request = urllib.request.Request(url, headers=headers or {})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, newurl):
                host = urllib.parse.urlsplit(newurl).hostname or ''
                if not blob or urllib.parse.urlsplit(newurl).scheme != 'https' or host not in DOCKER_BLOB_HOSTS:
                    raise ValueError('Registry redirect rejected')
                # CDN requests never receive Docker Hub bearer credentials.
                return urllib.request.Request(newurl)
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError('Registry metadata too large')
            return data, response.headers

    def get(self, suffix):
        if self.token is None:
            scope = urllib.parse.urlencode({'service': 'registry.docker.io', 'scope': 'repository:' + self.repository + ':pull'})
            self.token = json.loads(self.request('https://auth.docker.io/token?' + scope)[0])['token']
        return self.request('https://registry-1.docker.io/v2/' + self.repository + '/' + suffix, {'Authorization': 'Bearer ' + self.token, 'Accept': ACCEPT}, blob=suffix.startswith('blobs/'))

    def tags(self):
        tags, last = [], None
        for _ in range(30):
            suffix = 'tags/list?n=100' + ('&last=' + urllib.parse.quote(last, safe='') if last else '')
            body, headers = self.get(suffix)
            page = json.loads(body).get('tags') or []
            tags.extend(page)
            if not headers.get('Link'):
                return sorted({x for x in tags if VERSION.fullmatch(x)}, key=version_key)
            if not page or page[-1] == last:
                raise ValueError('Invalid registry pagination')
            last = page[-1]
        raise ValueError('Registry tag pagination limit exceeded')

    def resolve(self, ref, depth=0):
        if depth > 2 or not (ref == 'latest' or VERSION.fullmatch(ref) or DIGEST.fullmatch(ref)):
            raise ValueError('Invalid registry reference')
        body, headers = self.get('manifests/' + ref)
        digest = 'sha256:' + hashlib.sha256(body).hexdigest()
        if DIGEST.fullmatch(ref) and ref != digest:
            raise ValueError('Manifest digest mismatch')
        if headers.get('Docker-Content-Digest', digest) != digest:
            raise ValueError('Registry manifest identity mismatch')
        manifest = json.loads(body)
        if 'manifests' in manifest:
            matches = [x for x in manifest['manifests'] if x.get('platform', {}).get('os') == 'linux' and x.get('platform', {}).get('architecture') == 'amd64']
            if len(matches) != 1:
                raise ValueError('A unique linux/amd64 image is required')
            return self.resolve(matches[0]['digest'], depth + 1)
        config = manifest.get('config', {}).get('digest', '')
        if not DIGEST.fullmatch(config):
            raise ValueError('Unsupported manifest configuration')
        blob, _ = self.get('blobs/' + config)
        if 'sha256:' + hashlib.sha256(blob).hexdigest() != config:
            raise ValueError('Configuration digest mismatch')
        identity = json.loads(blob)
        if identity.get('os') != 'linux' or identity.get('architecture') != 'amd64':
            raise ValueError('Only linux/amd64 images are supported')
        layers = manifest.get('layers', [])
        return {'digest': digest, 'config_digest': config, 'size': sum(x.get('size', 0) for x in layers), 'diff_ids': identity.get('rootfs', {}).get('diff_ids', []), 'config': identity.get('config', {}), 'platform': 'linux/amd64'}

def same_content(image, target):
    if not image or image.get('Os') != 'linux' or image.get('Architecture') != 'amd64':
        return False
    if image.get('Id') == target.get('config_digest'):
        return True
    # containerd inspect IDs can identify manifests rather than configs.
    return bool(target.get('diff_ids')) and image.get('RootFS', {}).get('Layers') == target['diff_ids'] and image.get('Config') == target.get('config')

def identities():
    trusted(RELEASES)
    trusted(RELEASES.parent)
    return read(RELEASES, {}).get('images', [])

def inventory(cache=None, local=None):
    cache = cache if cache is not None else read(STATE / 'status.json', {})
    local = images() if local is None else local
    known = identities()
    rows = {}
    for node_id, entry in catalog().items():
        previous = cache.get('nodes', {}).get(node_id, {})
        releases = previous.get('releases', {})
        installed = []
        for image in local:
            for ref in image.get('RepoTags') or []:
                family, _, tag = ref.rpartition(':')
                if family != entry['family'] or not VERSION.fullmatch(tag):
                    continue
                version = None
                predecessor = False
                for record in known:
                    if record['repository'] != entry['repository']:
                        continue
                    digests = image.get('RepoDigests') or []
                    if image.get('Id') == record['config_digest'] or entry['repository'] + '@' + record['manifest_digest'] in digests:
                        version = record['version']
                    if record.get('previous_latest_digest') and entry['repository'] + '@' + record['previous_latest_digest'] in digests:
                        predecessor = True
                for stable, target in releases.items():
                    if same_content(image, target):
                        version = stable
                if same_content(image, previous.get('previous_identity', {})):
                    predecessor = True
                installed.append({'reference': ref, 'version': version, 'verified': bool(version), 'verified_previous': predecessor})
        versions = sorted({x['version'] for x in installed if x['version']}, key=version_key)
        latest = previous.get('latest_version') if installed else None
        older = bool(latest and ((versions and version_key(latest) > max(map(version_key, versions))) or (not versions and any(x['verified_previous'] for x in installed))))
        rows[node_id] = {**previous, 'installed': bool(installed), 'installed_versions': versions, 'installed_images': installed, 'latest_version': latest, 'available_versions': previous.get('available_versions', []) if installed else [], 'update_available': older, 'version_unverified': any(not x['verified'] for x in installed), 'error': previous.get('error') if installed else None}
    return rows

def jobs():
    result = []
    for path in sorted((STATE / 'jobs').glob('*.json')) if (STATE / 'jobs').exists() else []:
        with lock('job-' + path.stem):
            job = read(path)
            if job['state'] in ('queued', 'running'):
                try:
                    if job.get('boot_id') != boot_id():
                        raise ProcessLookupError()
                    if job['state'] == 'running':
                        os.kill(job['pid'], 0)
                        if job.get('process_start') is not None and job['process_start'] != process_start(job['pid']):
                            raise ProcessLookupError()
                    elif time.time() - path.stat().st_mtime > 120:
                        raise ProcessLookupError()
                except ProcessLookupError:
                    job.update(state='failed', error='Worker interrupted; retry the operation', updated_at=now())
                    atomic(path, job)
        result.append(job)
    result.sort(key=lambda job: (job['created_at'], job['job_id']))
    active = [job for job in result if job['state'] in ('queued', 'running')]
    history = [job for job in result if job['state'] not in ('queued', 'running')]
    return active + history[-30:]

def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def process_start(pid):
    try:
        return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, IndexError):
        raise ProcessLookupError()

def save_job(job):
    with lock('job-' + job['job_id']):
        atomic(STATE / 'jobs' / (job['job_id'] + '.json'), job)

def status():
    cache = read(STATE / 'status.json', {})
    active = jobs()
    return {'checking': any(x['operation'] == 'check' and x['state'] in ('queued', 'running') for x in active), 'checked_at': cache.get('checked_at'), 'error': cache.get('error'), 'nodes': inventory(cache), 'jobs': active}

def validate(args):
    if not isinstance(args, dict):
        raise ValueError('Invalid arguments')
    operation = args.get('operation')
    fields = {'status': {'operation'}, 'check': {'operation'}, 'install': {'operation', 'node_id', 'version'}, 'job': {'operation', 'job_id'}, 'remove': {'operation', 'node_id', 'reference'}}
    if operation not in fields or set(args) - fields[operation]:
        raise ValueError('Invalid update operation/arguments')
    if operation in ('install', 'remove'):
        if isinstance(args.get('node_id'), bool) or str(args.get('node_id')) not in catalog():
            raise ValueError('Unknown managed node')
    if operation == 'install':
        version = args.get('version', 'latest')
        if not isinstance(version, str) or not (version == 'latest' or VERSION.fullmatch(version)):
            raise ValueError('Invalid stable version')
    if operation == 'job' and not re.fullmatch(r'[a-f0-9]{32}', str(args.get('job_id', ''))):
        raise ValueError('Invalid job identity')
    if operation == 'remove' and args.get('reference') is not None:
        family = catalog()[str(args['node_id'])]['family']
        ref = args['reference']
        if not isinstance(ref, str) or not ref.startswith(family + ':') or not VERSION.fullmatch(ref[len(family)+1:]):
            raise ValueError('Invalid managed reference')

def dispatch(args):
    validate(args)
    operation = args['operation']
    if operation == 'status':
        return status()
    if operation == 'job':
        job = read(STATE / 'jobs' / (args['job_id'] + '.json'))
        if not job:
            raise ValueError('Unknown job')
        jobs()  # detect interrupted worker
        return read(STATE / 'jobs' / (args['job_id'] + '.json'))
    with lock('dispatch'):
        for job in jobs():
            if job['state'] in ('queued', 'running') and job['operation'] == operation and (operation == 'check' or (job.get('node_id') == str(args['node_id']) and job.get('version', 'latest') == args.get('version', 'latest') and job.get('reference') == args.get('reference'))):
                return job
        job = {**args, 'job_id': uuid.uuid4().hex, 'state': 'queued', 'created_at': now(), 'updated_at': now(), 'error': None, 'log': '', 'boot_id': boot_id()}
        if 'node_id' in job:
            job['node_id'] = str(job['node_id'])
        path = STATE / 'jobs' / (job['job_id'] + '.json')
        atomic(path, job)
        try:
            launch(job['job_id'])
        except Exception as error:
            job.update(state='failed', error=str(error)[:2000], updated_at=now())
            atomic(path, job)
        return job

def launch(job_id):
    # A separate systemd cgroup survives broker/boot-service restarts.
    result = subprocess.run(['systemd-run', '--quiet', '--collect', '--unit=pnet-docker-update-' + job_id, '--property=UMask=0077', '/usr/bin/python3', str(Path(__file__).resolve()), '--worker', job_id], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-2000:] or 'Unable to start update worker')

def check():
    cache = read(STATE / 'status.json', {})
    rows = inventory(cache)
    failures = []
    for node_id, row in rows.items():
        if not row['installed']:
            continue
        try:
            registry = Registry(catalog()[node_id]['repository'])
            tags = registry.tags()
            if not tags:
                raise ValueError('No stable published versions')
            latest = tags[-1]
            # Resolve latest stable plus installed tag candidates to prove identity.
            targets = row.get('releases', {})
            for tag in {latest} | {x['reference'].rpartition(':')[2] for x in row['installed_images']}:
                if tag in tags:
                    targets[tag] = registry.resolve(tag)
            record = next((x for x in identities() if x['repository'] == registry.repository), None)
            if record:
                try:
                    row['previous_identity'] = registry.resolve(record['previous_latest_digest'])
                except Exception:
                    # Legacy identity discovery is optional; errors never prove outdated.
                    pass
            row.update(latest_version=latest, available_versions=tags, releases=targets, checked_at=now(), error=None)
        except Exception as error:
            row['error'] = str(error)[:2000]
            failures.append(node_id + ': ' + row['error'])
    cache.update(nodes=rows, attempted_at=now(), error='; '.join(failures) or None)
    if not failures:
        cache['checked_at'] = now()
    atomic(STATE / 'status.json', cache)

def install(job):
    entry = catalog()[job['node_id']]
    registry = Registry(entry['repository'])
    progress(job, 'Resolving published image identity')
    version = job.get('version', 'latest')
    checked = read(STATE / 'status.json', {}).get('nodes', {}).get(job['node_id'], {}).get('releases', {}).get(version)
    target = registry.resolve(checked['digest'] if checked else version)
    if checked and target['config_digest'] != checked['config_digest']:
        raise ValueError('Checked release identity no longer agrees with registry')
    if version == 'latest':
        # Only assign a release label when a stable tag resolves to identical content.
        version = None
        for tag in reversed(registry.tags()):
            stable = registry.resolve(tag)
            if stable['digest'] == target['digest']:
                version = tag
                break
    before = inventory()[job['node_id']]
    job.update(target_digest=target['digest'], resolved_version=version)
    progress(job, 'Verified frozen image digest ' + target['digest'])
    if before['installed'] and not version:
        raise ValueError('Latest has no verified stable version; cannot install side by side')
    destination = entry['family'] + ':' + version if version else entry['alias']
    destinations = [destination]
    if not before['installed'] and entry['alias'] not in destinations:
        destinations.append(entry['alias'])
    for ref in destinations:
        existing = inspect(ref)
        if existing and not same_content(existing, target):
            raise ValueError('Existing image tag collision: ' + ref)
    cached = next((x for x in images() if same_content(x, target)), None)
    reused = cached is not None
    if cached is None:
        data_root = json.loads(command(['info', '--format', '{{json .DockerRootDir}}']))
        free = shutil.disk_usage(data_root).free
        if free < max(2 * 1024**3, target['size'] * 3 + 1024**3):
            raise ValueError('Insufficient Docker disk space for safe installation')
        ref = entry['repository'] + '@' + target['digest']
        progress(job, 'Pulling verified digest ' + target['digest'])
        command(['pull', '--platform=linux/amd64', ref], timeout=1800)
        cached = inspect(ref)
    if not same_content(cached, target):
        raise ValueError('Pulled image content failed verification')
    progress(job, 'Publishing verified side-by-side image tags')
    # Check all tags again immediately before publication; never replace old aliases.
    for ref in destinations:
        existing = inspect(ref)
        if existing and not same_content(existing, target):
            raise ValueError('Existing image tag collision: ' + ref)
    for ref in destinations:
        if not inspect(ref):
            command(['tag', cached['Id'], ref])
    cache = read(STATE / 'status.json', {})
    row = cache.setdefault('nodes', {}).setdefault(job['node_id'], {})
    if version:
        row.setdefault('releases', {})[version] = target
    atomic(STATE / 'status.json', cache)
    atomic(STATE / 'provenance' / (job['job_id'] + '.json'), {'repository': entry['repository'], 'version': version, 'target': target, 'destinations': destinations, 'installed_at': now()})
    return 'Installed ' + ', '.join(destinations) + (' using verified cached content' if reused else '')

def protected(refs):
    local = images()
    selected_ids = {x['Id'] for x in local if set(x.get('RepoTags') or []) & set(refs)}
    aliases = set(refs)
    for image in local:
        if image['Id'] in selected_ids:
            aliases.update(image.get('RepoTags') or [])
    containers = command(['ps', '-aq']).split()
    for start in range(0, len(containers), 50):
        for container in json.loads(command(['inspect'] + containers[start:start+50])):
            if container.get('Image') in selected_ids or container.get('Config', {}).get('Image') in aliases:
                raise ValueError('Image used by retained container ' + container.get('Name', ''))
    if not LABS.is_dir():
        raise ValueError('Cannot verify saved labs: directory missing')
    def traversal_error(error):
        raise ValueError('Cannot verify saved labs: traversal error') from error
    for directory, dirs, files in os.walk(LABS, onerror=traversal_error, followlinks=False):
        for name in dirs + files:
            if Path(directory, name).is_symlink():
                raise ValueError('Cannot verify saved labs: symlink found')
        for name in files:
            if not name.endswith('.unl'):
                continue
            path = Path(directory, name)
            try:
                root = ET.parse(path).getroot()
            except (ET.ParseError, OSError) as error:
                raise ValueError('Cannot verify saved lab references: ' + str(path)) from error
            if any(node.get('image') in aliases for node in root.iter('node')):
                raise ValueError('Image referenced by saved lab ' + str(path.relative_to(LABS)))

def guard_remove(ref):
    """Called by raw broker rmi too, so image-ID aliases cannot bypass guards."""
    local = images()
    families = {x['family'] for x in catalog().values()}
    selected = [x for x in local if ref == x['Id'] or ref in (x.get('RepoTags') or []) or ref in (x.get('RepoDigests') or []) or (re.fullmatch(r'[a-f0-9]{12,64}', ref or '') and x['Id'][7:].startswith(ref))]
    for image in selected:
        refs = image.get('RepoTags') or []
        if any(x.rpartition(':')[0] in families for x in refs):
            protected(refs)

def remove(job):
    entry = catalog()[job['node_id']]
    refs = [job['reference']] if job.get('reference') else [x['reference'] for x in inventory()[job['node_id']]['installed_images']]
    if not refs:
        return 'No installed managed tags'
    protected(refs)
    command(['rmi'] + refs)
    return 'Removed ' + ', '.join(refs)

def worker(job_id):
    path = STATE / 'jobs' / (job_id + '.json')
    # Dispatch writes pid under this lock, preventing a fast worker write race.
    with lock('dispatch'):
        job = read(path)
        job.update(state='running', pid=os.getpid(), process_start=process_start(os.getpid()), updated_at=now())
        save_job(job)
    try:
        with lock('mutation'):
            if job['operation'] == 'check':
                check()
                checked = read(STATE / 'status.json', {})
                if checked.get('error'):
                    raise RuntimeError('Metadata check incomplete: ' + checked['error'])
                message = 'Metadata check complete'
            elif job['operation'] == 'install':
                message = install(job)
            else:
                message = remove(job)
        job.update(state='succeeded', log=message)
    except Exception as error:
        job.update(state='failed', error=str(error)[:2000], log=str(error)[:2000])
    job['updated_at'] = now()
    save_job(job)

def progress(job, message):
    job.update(log=message, updated_at=now())
    save_job(job)

def main():
    if os.geteuid() != 0:
        raise ValueError('Root required')
    if len(sys.argv) == 3 and sys.argv[1] == '--worker' and re.fullmatch(r'[a-f0-9]{32}', sys.argv[2]):
        worker(sys.argv[2])
    elif sys.argv[1:] == ['--boot']:
        with lock('boot'):
            if read(STATE / 'boot.json', {}).get('boot_id') != boot_id():
                dispatch({'operation': 'check'})
                atomic(STATE / 'boot.json', {'boot_id': boot_id()})
    else:
        raise ValueError('Invalid helper invocation')

if __name__ == '__main__':
    main()
