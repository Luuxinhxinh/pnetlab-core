<?php

// The EVE-NG task parser is dependency-free (SimpleXML/DOM/mbstring only) and is
// called from the constructor, so this file owns the require rather than relying
// on init.php: it keeps the whole change inside the engine-custom overlay, which
// is the only tree scripts/deploy-gate.sh can deploy.
require_once __DIR__ . '/lab_tasks_unl.php';

class Lab
{
    private $author;
    private $body;
    private $description;
    private $filename;
    private $id;
    private $name;
    private $networks = array();
    private $nodes = array();
    private $path;
    private $textobjects = array();
    private $pictures = array();
    private $tenant;
    private $version;
    private $scripttimeout;
    private $password;

    //=====================PNETLAB==========================
    private $isEncrypt = false;
    private $session;
    public $node_sessions = array(); // session data of all node of this lab session, using to create node
    public $if_sessions = array(); // session data of all interface of this lab session, using to edit interface
    private $lab_session = array();
    private $logDecrypt = '';
    private $logCode = 0;
    private $labId = '';
    private $runningNodes = null;
    private $file = null;
    private $countdown = 60;
    private $darkmode = 1;
    private $mode3d = 1;
    private $nogrid = 0;

    private $joinable = null; // 0: admin only, 1: everyone, 2: specific by joinable email
    private $joinable_emails = array();

    private $openable = null; // 0: admin only, 1: everyone, 2: specific by joinable email
    private $openable_emails = array();

    private $editable = null; // 0: admin only, 1: everyone, 2: specific by joinable email
    private $editable_emails = array();



    /**
     * Constructor which load an existent lab or create an empty one.
     *
     * @param     string  $f                  the file of the lab with full path
     * @param     int     $tenant             Tenant ID
     * @return    void
     */
    public function __construct($f, $tenant, $session = null, $email = null)
    {
       
        $modified = False;
        $this->session = $session;
        if ($session != null) {
            $this->node_sessions = $this->getNodeSessions($session);
            $this->if_sessions = $this->getIfSessions($session);
            $this->lab_session = getLabFromSession($session);
        }
        $this->tenant = (int) $tenant;
        $this->file = $f;

        $this->filename = basename($f);
        $this->path = dirname($f);


        if (!checkLabFilename($this->filename)) {
            // Invalid filename
            error_log(date('M d H:i:s ') . 'ERROR: ' . $f . ' ' . $GLOBALS['messages'][20001]);
            emptyLabSession($tenant);
            throw new Exception('20001');
        }

        if (!checkLabPath($this->path)) {
            // Invalid path
            error_log(date('M d H:i:s ') . 'ERROR: ' . $f . ' ' . $GLOBALS['messages'][20002]);
            emptyLabSession($tenant);
            throw new Exception('20002');
        }

        //==========PNETLAB=============================
        // The legacy Laravel-store Sample_LAB.unl fallback (cloning
        // /opt/unetlab/html/store/storage/app/Sample_LAB.unl into a missing
        // .unl, stamping join/open/edit onto $email) is RETIRED with the
        // Laravel store (Phase C decommission): the file never exists on a
        // fresh install, so a missing lab file always seeds an empty lab.
        //==========PNETLAB=============================
        if (!is_file($f)) {
            // File does not exist, create a new empty lab
            $this->name = substr(basename($f), 0, -4);
            $this->id = genUuid();
            $modified = True;
            //==========PNETLAB=============================
            // Seed a valid empty <lab> document so the shared parsing tail
            // below (//lab/@countdown, //lab/@darkmode, ...) has a real $xml
            // to query. Without this, opening a lab whose .unl no longer
            // exists left $xml undefined and surfaced as an "Undefined
            // variable $xml" toast in the topology instead of an empty lab.
            $xml = simplexml_load_string(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                . '<lab name="' . htmlspecialchars($this->name, ENT_QUOTES)
                . '" id="' . $this->id . '"></lab>',
                'SimpleXMLElement',
                LIBXML_PARSEHUGE
            );
            //==========PNETLAB=============================
        } else {

            libxml_use_internal_errors(true);

            //==========PNETLAB=============================
            $unlContent = file_get_contents($f);

            if (substr($unlContent, 0, 5) == '<?xml') {
                $this->isEncrypt = false;
                
            } else {
                
                $unlContent = $this->crypt_lab($unlContent, null, 'd');
                if (!$unlContent) {
                    emptyLabSession($tenant);
                    throw new ResponseException($this->logDecrypt, ['id' => $this->labId], $this->logCode);
                }
                $this->isEncrypt = true;
            }

            $xml = simplexml_load_string($unlContent, 'SimpleXMLElement', LIBXML_PARSEHUGE);

            //==========PNETLAB=============================

            if (!$xml) {
                // Invalid XML document
                $errorLog = '';
                foreach (libxml_get_errors() as $error) {
                    $errorLog .= $error->message;
                }
                error_log(date('M d H:i:s ') . 'ERROR: ' . $f . ' ' . $GLOBALS['messages'][20003] . $errorLog);
                emptyLabSession($tenant);
                throw new Exception('20003');
            }

            // Lab name
            $patterns[0] = '/\.unl$/';
            $replacements[0] = '';
            $this->name = preg_replace($patterns, $replacements, basename($f));


            /** ===========PNETLAB workbook ===============*/
            $result = $xml->xpath('//lab/workbooks');
            if (isset($result[0])) {
                $this->workbooks = [];
                foreach ($result[0]->workbook as $workbook) {
                    $name = (string) $workbook->attributes()->id;
                    $type = (string) $workbook->attributes()->type;
                    $weight = (string) $workbook->attributes()->weight;
                    $kind = (string) $workbook->attributes()->kind;
                    $wb = (object) [
                        'name' => $name,
                        'type' => $type,
                        'weight' => $weight,
                        'kind' => ($kind !== '' ? $kind : null),
                    ];
                    if ($type == 'pdf') {
                        if (isset($workbook->content[0])) {
                            $content = (string) $workbook->content[0];
                        } else {
                            $content = '';
                        }
                        $wb->content = $content;
                    } else {
                        $wb->content = [];
                        if (isset($workbook->content[0])) {
                            foreach ($workbook->content[0]->page as $page) {
                                $wb->content[] = (string) $page;
                            }
                        }

                        if (isset($workbook->menu[0])) {
                            $wb->menu = json_decode((string) $workbook->menu[0]);
                        }
                    }

                    $this->workbooks[] = $wb;
                }
            }
            /** =============================================*/

            $eveParsed = unlTasksParseEve($unlContent);
            $eveTaskCount = isset($eveParsed['tasks']) && is_array($eveParsed['tasks'])
                ? count($eveParsed['tasks']) : 0;
            $eveSkippedCount = isset($eveParsed['skipped']) && is_array($eveParsed['skipped'])
                ? count($eveParsed['skipped']) : 0;
            if (($eveTaskCount + $eveSkippedCount) > 0) {
                $this->eveImportStats = $this->importEveTasks($eveParsed);
            }

            // Lab ID
            $result = $xml->xpath('//lab/@id');
            if (empty($result)) {
                // Lab ID not set, create a new one
                $this->id = genUuid();
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20011]);
                $modified = True;
            } else if (!checkUuid($result[0]) || (string) $result[0] === '00000000-0000-0000-0000-000000000000') {
                // Attribute not a valid UUID, OR the nil (all-zero) UUID. The nil
                // id passes checkUuid()'s hex pattern but is semantically "unset":
                // the retired store's Sample_LAB.unl template carried it, so every
                // lab cloned from it (pre-retirement labs still exist) inherited
                // the nil id. addLabSession() dedupes lab sessions by this id, so
                // all such labs collapsed onto ONE shared session and every lab
                // opened the same topology. Force a fresh id.
                $this->id = genUuid();
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20012]);
                $modified = True;
            } else {
                $this->id = (string) $result[0];
            }

            $result = $xml->xpath('//lab/@multi_config_active');
            if (isset($result)) {
                $this->multi_config_active = (string) array_pop($result);
            }

            // Lab description
            $result = $xml->xpath('//lab/description');
            $result = (string) array_pop($result);
            if (strlen($result) !== 0) {
                $this->description = htmlspecialchars($result, ENT_DISALLOWED, 'UTF-8', TRUE);
            } else if (strlen($result) !== 0) {
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20006]);
            }

            // Lab body
            $result = $xml->xpath('//lab/body');
            $result = (string) array_pop($result);
            if (strlen($result) !== 0) {
                $this->body = htmlspecialchars($result, ENT_DISALLOWED, 'UTF-8', TRUE);
            } else if (strlen($result) !== 0) {
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20006]);
            }

            // Lab author
            $result = $xml->xpath('//lab/@author');
            $result = (string) array_pop($result);
            if (strlen($result) !== 0) {
                $this->author = htmlspecialchars($result, ENT_DISALLOWED, 'UTF-8', TRUE);
            } else if (strlen($result) !== 0) {
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20007]);
            }

            // Lab version
            $result = $xml->xpath('//lab/@version');
            $result = (string) array_pop($result);
            if (strlen($result) !== 0 && (int) $result >= 0) {
                $this->version = $result;
            } else if (strlen($result) !== 0) {
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20008]);
            }

            // Lab networks
            foreach ($xml->xpath('//lab/topology/networks/network') as $network) {
                $w = array();
                if (isset($network->attributes()->id)) $w['id'] = (string) $network->attributes()->id;
                if (isset($network->attributes()->left)) $w['left'] = (string) $network->attributes()->left;
                if (isset($network->attributes()->name)) $w['name'] = (string) $network->attributes()->name;
                if (isset($network->attributes()->top)) $w['top'] = (string) $network->attributes()->top;
                if (isset($network->attributes()->type)) $w['type'] = (string) $network->attributes()->type;
                if (isset($network->attributes()->visibility)) $w['visibility'] = (string) $network->attributes()->visibility;
                if (isset($network->attributes()->icon)) $w['icon'] = (string) $network->attributes()->icon;
                if (isset($network->attributes()->size)) $w['size'] = (string) $network->attributes()->size;
                if (isset($network->attributes()->smart)) $w['smart'] = (string) $network->attributes()->smart;
                if (isset($network->attributes()->vlan8021ad)) $w['vlan8021ad'] = (string) $network->attributes()->vlan8021ad;


                try {
                    $this->networks[$w['id']] = new Network($w, $w['id'], $this);
                } catch (Exception $e) {
                    // Invalid network
                    error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ':net' . $w['id'] . ' ' . $GLOBALS['messages'][20009]);
                    error_log(date('M d H:i:s ') . (string) $e);
                    continue;
                }
            }

            // Lab nodes (networks must be alredy loaded)
            $legacyPlacements = [];
            foreach ($xml->xpath('//lab/topology/nodes/node') as $node_id => $node) {
                $n = array();

                if (isset($node->attributes()->id)) $n['id'] = (int) $node->attributes()->id;
                if (isset($node->attributes()->template)) $n['template'] = (string) $node->attributes()->template;
                if (isset($node->attributes()->type)) $n['type'] = (string) $node->attributes()->type;


                $this->nodes[$n['id']] = new Node($n, $n['id'], $this->tenant, $this, $this->node_sessions);

                $params = [];
                $options = $this->nodes[$n['id']]->getOptions();
                foreach ($options as $key => $value) {
                    if (isset($node->attributes()->$key)) $params[$key] = (string) $node->attributes()->$key;
                }

                // Collect legacy cluster_host XML attrs for migration (not via getOptions — removed).
                $xmlHost = (int) $node->attributes()->cluster_host;
                if ($xmlHost > 0) {
                    $legacyPlacements[$n['id']] = $xmlHost;
                }

                /** Get config and multi config for old .unl lab file */
                try {
                    // If config is empty, force "None"
                    $result = $xml->xpath('//lab/objects/configs/config[@id="' . $n['id'] . '"]');
                    $result = (string) array_pop($result);
                    if (strlen($result) > 0) {
                        $params['config_data'] = $result;
                    }

                    /* PNETLAB load multi config */
                    $multiConfig = $xml->xpath('//lab/multi_configs/multi_config_lab[@id="' . $n['id'] . '"]');
                    $multiConfig = (string) array_pop($multiConfig);
                    if (strlen($result) > 0) {
                        $params['multi_config'] = $multiConfig;
                    }
                } catch (Exception $th) {
                    //throw $th;
                }

                $this->nodes[$n['id']]->edit($params);

                foreach ($node->interface as $interface) {
                    // Loading configured interfaces for this node
                    $i = array();
                    $attrs = $interface->attributes();

                    $i['id'] = (string) $interface->attributes()->id;
                    $i['type'] = (string) $interface->attributes()->type;
                    $i['networks'] = $this->networks;

                    foreach ($attrs as $key => $value) {
                        $i[$key] = (string) $value;
                    }

                    $this->nodes[$n['id']]->linkInterface($i);
                }

            }
            // Migrate legacy XML cluster_host attrs to DB (INSERT IGNORE — DB wins).
            // Must not set $modified; the attrs disappear on the next real save.
            if (!empty($legacyPlacements) && function_exists('cluster_placements_migrate')) {
                cluster_placements_migrate($this->id, $legacyPlacements);
            }

            // lab script timeout
            $result = $xml->xpath('//lab/@scripttimeout');
            $result = (string) array_pop($result);
            if (strlen($result) !== 0 && (int) $result >= 300) {
                $this->scripttimeout = $result;
            } else if (strlen($result) !== 0) {
                error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ' ' . $GLOBALS['messages'][20045]);
                $this->scripttimeout = 300;
            }
            // lab lock
            $result = $xml->xpath('//lab/@password');
            $result = (string) array_pop($result);
            $this->password = $result;

            // Lab Pictures
            foreach ($xml->xpath('//lab/objects/pictures/picture') as $picture) {
                $p = array();
                if (isset($picture->attributes()->id)) $p['id'] = (string) $picture->attributes()->id;
                if (isset($picture->attributes()->name)) $p['name'] = (string) $picture->attributes()->name;
                if (isset($picture->attributes()->type)) $p['type'] = (string) $picture->attributes()->type;
                $result = $picture->xpath('./data');
                $result = (string) array_pop($result);
                if (strlen($result) > 0) $p['data'] = base64_decode($result);
                $result = $picture->xpath('./map');
                $result = (string) array_pop($result);
                
                if (strlen($result) > 0) $p['map'] = html_entity_decode($result);
                
                try {
                    $this->pictures[$p['id']] = new Picture($p, $p['id']);
                } catch (Exception $e) {
                    // Invalid picture
                    error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ':pic' . $p['id'] . ' ' . $GLOBALS['messages'][20020]);
                    error_log(date('M d H:i:s ') . (string) $e);
                    continue;
                }
            }

            // Text Objects
            foreach ($xml->xpath('//lab/objects/textobjects/textobject') as $textobject) {
                $p = array();
                if (isset($textobject->attributes()->id)) $p['id'] = (string) $textobject->attributes()->id;
                if (isset($textobject->attributes()->name)) $p['name'] = (string) $textobject->attributes()->name;
                if (isset($textobject->attributes()->type)) $p['type'] = (string) $textobject->attributes()->type;
                $result = $textobject->xpath('./data');
                $result = (string) array_pop($result);
                if (strlen($result) > 0) $p['data'] = $result;

                try {
                    $this->textobjects[$p['id']] = new TextObject($p, $p['id']);
                } catch (Exception $e) {
                    // Invalid picture
                    error_log(date('M d H:i:s ') . 'WARNING: ' . $f . ':obj' . $p['id'] . ' ' . $GLOBALS['messages'][20041]);
                    error_log(date('M d H:i:s ') . (string) $e);
                    continue;
                }
            }

            /** PNETLAB line */
            $this->lineobjects = [];
            foreach ($xml->xpath('//lab/objects/lineobjects/lineobject') as $lineobject) {
                $p = array();
                if (isset($lineobject->attributes()->id)) $p['id'] = (string) $lineobject->attributes()->id;
                if (isset($lineobject->attributes()->width)) $p['width'] = (string) $lineobject->attributes()->width;
                if (isset($lineobject->attributes()->linestyle)) $p['linestyle'] = (string) $lineobject->attributes()->linestyle;
                if (isset($lineobject->attributes()->paintstyle)) $p['paintstyle'] = (string) $lineobject->attributes()->paintstyle;
                if (isset($lineobject->attributes()->color)) $p['color'] = (string) $lineobject->attributes()->color;
                if (isset($lineobject->attributes()->label)) $p['label'] = (string) $lineobject->attributes()->label;
                if (isset($lineobject->attributes()->endsym)) $p['endsym'] = (string) $lineobject->attributes()->endsym;
                if (isset($lineobject->attributes()->startsym)) $p['startsym'] = (string) $lineobject->attributes()->startsym;
                if (isset($lineobject->attributes()->x1)) $p['x1'] = (string) $lineobject->attributes()->x1;
                if (isset($lineobject->attributes()->x2)) $p['x2'] = (string) $lineobject->attributes()->x2;
                if (isset($lineobject->attributes()->y1)) $p['y1'] = (string) $lineobject->attributes()->y1;
                if (isset($lineobject->attributes()->y2)) $p['y2'] = (string) $lineobject->attributes()->y2;
                if (isset($lineobject->attributes()->linecfg)) $p['linecfg'] = (string) $lineobject->attributes()->linecfg;
                $this->lineobjects[$p['id']] = $p;
            }
        }

        $result = $xml->xpath('//lab/@countdown');
        $result = (string) array_pop($result);
        $this->countdown = $result;

        // Background mode: only override the class defaults (dark + 3D, grid on)
        // when the lab XML actually carries the attribute. A lab that was never
        // toggled has no @darkmode/@mode3d, and the old code overwrote the default
        // with '' (→ light 2D). Keeping the default when the attribute is absent
        // makes dark + 3D the default layout, while an explicit "0" (user chose
        // light / 2D) is still respected.
        $result = $xml->xpath('//lab/@darkmode');
        $result = (string) array_pop($result);
        if ($result !== '') $this->darkmode = $result;

        $result = $xml->xpath('//lab/@mode3d');
        $result = (string) array_pop($result);
        if ($result !== '') $this->mode3d = $result;

        $result = $xml->xpath('//lab/@nogrid');
        $result = (string) array_pop($result);
        if ($result !== '') $this->nogrid = $result;

        if ($this->joinable === null) {
            $result = $xml->xpath('//lab/@joinable');
            $result = (string) array_pop($result);
            $this->joinable = $result;

            $result = $xml->xpath('//lab/@joinable_emails');
            $result = (string) array_pop($result);
            if ($result == '') $this->joinable_emails = [];
            $this->joinable_emails = explode(',', $result);
        }


        if ($this->openable === null) {
            $result = $xml->xpath('//lab/@openable');
            $result = (string) array_pop($result);
            $this->openable = $result;

            $result = $xml->xpath('//lab/@openable_emails');
            $result = (string) array_pop($result);
            if ($result == '') $this->openable_emails = [];
            $this->openable_emails = explode(',', $result);
        }

        if ($this->editable === null) {
            $result = $xml->xpath('//lab/@editable');
            $result = (string) array_pop($result);
            $this->editable = $result;

            $result = $xml->xpath('//lab/@editable_emails');
            $result = (string) array_pop($result);
            if ($result == '') $this->editable_emails = [];
            $this->editable_emails = explode(',', $result);
        }

        if ($modified) {
            // Need to save
            $rc = $this->save();
            if ($rc != 0) {
                emptyLabSession($tenant);
                throw new Exception($rc);
                return $rc;
            }
        }

        return 0;
    }




    private function crypt_data($string, $action = 'e')
    {
        // you may change these values to your own
        try {

            $secret_key = "gsgsgsghkjjghksgs%^465#";
            $secret_iv = "etwdgsio##kljhjgf%^465#";

            $output = false;
            $encrypt_method = "AES-256-CBC";
            $key = hash('sha256', $secret_key);
            $iv = substr(hash('sha256', $secret_iv), 0, 16);
            if ($action == 'e') {
                $output = base64_encode(openssl_encrypt(time() . '##time##' . $string, $encrypt_method, $key, 0, $iv));
            } else if ($action == 'd') {
                $output = openssl_decrypt(base64_decode($string), $encrypt_method, $key, 0, $iv);

                $outputArray = explode('##time##', $output);
                $output = [];
                $output['payload'] = $outputArray[1];
                $output['iat'] = $outputArray[0];
            }
            return $output;
        } catch (\Exception $e) {
            return false;
        }
    }


    private function crypt_lab($content, $id, $action = 'e')
    {
        $this->logDecrypt = '';
        $this->logCode = 0;
        try {
            $pattern = 'amxranNnaGdq';
            if ($action == 'e') {
                $content = base64_encode($content);
                $firstPart = $id . $pattern . substr($content, 0, 10000);
                $theRest = substr($content, 10000);
                $firstE = $this->crypt_data($firstPart, 'e');
                return $firstE . $pattern . $theRest;
            } else {

                $labArray = explode($pattern, $content);
                if (!isset($labArray[1])) $labArray[1] = '';
                $decryptData = $this->crypt_data($labArray[0], 'd');
                $decryptData = $decryptData['payload'];
                $decryptArray = explode($pattern, $decryptData);

                $id = $decryptArray[0];
                $this->labId = $id;
                $lab = $decryptArray[1] . $labArray[1];
                $lab = base64_decode($lab);

                return $lab;
            }
        } catch (\Exception $e) {
            return false;
        }
    }

    
    private function getNodeSessions($lab_session)
    {
        
        $nodeSessions = array();
        $nodeModel = loadModel('node_sessions');
        $result = $nodeModel->get([[NODE_SESSION_LAB, '=', $lab_session]]);
        array_map(function ($item) use (&$nodeSessions) {
            $nodeSessions[$item[NODE_SESSION_NID]] = $item;
        }, $result);
        return $nodeSessions;
    }

    private function getIfSessions($lab_session)
    {
        $ifSessions = array();
        $nodeModel = loadModel('if_sessions');
        $result = $nodeModel->get([[IF_SESSION_LAB, '=', $lab_session]]);
        array_map(function ($item) use (&$ifSessions) {
            $ifSessions[$item[IF_SESSION_NODE] . '_' . $item[IF_SESSION_IFID]] = $item;
        }, $result);
        return $ifSessions;
    }

    public function getSession()
    {
        return $this->session;
    }

    public function getFile()
    {
        return $this->file;
    }

    public function getCountdown()
    {
        return $this->countdown;
    }

    public function getOpenable()
    {
        return $this->openable;
    }

    public function getJoinable()
    {
        return $this->joinable;
    }

    public function getEditable()
    {
        return $this->editable;
    }

    public function getOpenableEmails()
    {
        return $this->openable_emails;
    }

    public function getJoinableEmails()
    {
        return $this->joinable_emails;
    }

    public function getEditableEmails()
    {
        return $this->editable_emails;
    }


    /**
     * Method to add a new network.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function addNetwork($p)
    {
         $p['id'] = $this->getFreeNetworkId();

        // dot1q switches and wireless cells are vlan_filtering bridges: mark them
        // smart so device_qemu::prepare() re-applies each port's access/trunk VLAN
        // at node start (the AP trunk + per-VLAN wired access ports).
        if (isset($p['type']) && ($p['type'] == 'dot1q' || $p['type'] == 'wireless')) {
            $p['smart'] = 1;
        }

        // Adding the network
        try {
            $this->networks[$p['id']] = new Network($p, $p['id'], $this);
            $this->networks[$p['id']]->addSysNetwork();
            return $this->save();
        } catch (Exception $e) {
            // Failed to create the network
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?net=' . $p['id'] . ' ' . $GLOBALS['messages'][20021]);
            error_log(date('M d H:i:s ') . (string) $e);
            return 20021;
        }
        return 0;
    }

    /**
     * Method to add a new node.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function addNode($p)
    {
        $p['id'] = $this->getFreeNodeId();

        // Guarantee a UNIQUE node name on the topology. CDP/LLDP-based tooling
        // (the protocol overlays / SPF tree) correlates CLI hostnames back to
        // canvas nodes, so two nodes sharing a name collide and mis-map. The
        // duplicate-node action and raw API posts can reuse an existing name;
        // auto-increment to the next free "<base>-<n>" on a collision. Batch
        // adds (already id-suffixed) and already-unique names pass through.
        if (isset($p['name'])) {
            $p['name'] = $this->uniqueNodeName((string) $p['name']);
        }

        // Add the node
        try {
            $this->nodes[$p['id']] = new Node($p, $p['id'], $this->tenant, $this, $this->node_sessions);
            return $this->save();
        } catch (Exception $e) {
            // Failed to create the node
            //error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $p['id'] . ' ' . $GLOBALS['messages'][20022]);
           // error_log(date('M d H:i:s ') . (string) $e);
            return 20022;
        }
    }

    /**
     * Return a node name unique within this lab. If $name is free it is kept as
     * is; otherwise the trailing "-<n>" is stripped to a base and the next free
     * "<base>-<n>" is returned (base-1, base-2, …). Mirrors the Add-Node form's
     * client-side auto-increment (pnetlab-node-form.js) so every creation path —
     * the form, batch add, the React duplicate action, raw API — yields unique
     * names (required by the CDP/LLDP hostname correlation in the overlays).
     *
     * @param   string  $name               Desired node name
     * @return  string                       A name not used by any current node
     */
    private function uniqueNodeName($name)
    {
        $name = trim($name);
        if ($name === '') {
            $name = 'Node';
        }
        $existing = array();
        foreach ($this->nodes as $n) {
            $existing[$n->getName()] = true;
        }
        if (!isset($existing[$name])) {
            return $name;
        }
        $base = preg_replace('/-\d+$/', '', $name);
        if ($base === '') {
            $base = $name;
        }
        $i = 1;
        while (isset($existing[$base . '-' . $i])) {
            $i++;
        }
        return $base . '-' . $i;
    }

    /**
     * Method to add a new text object.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function addTextObject($p)
    {
        $p['id'] = 1;
        $object = new stdClass();
        $object->id = -1;
        $object->status = 0;
        // Finding a free object ID
        while (True) {
            if (!isset($this->textobjects[$p['id']])) {
                break;
            } else {
                $p['id'] = $p['id'] + 1;
            }
        }

        // Adding the object
        try {
            $this->textobjects[$p['id']] = new TextObject($p, $p['id']);
            $this->save();
            $object->id = $p['id'];
            $object->status = 0;
            return $object;
        } catch (Exception $e) {
            // Failed to create the picture
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?pic=' . $p['id'] . ' ' . $GLOBALS['messages'][20042]);
            error_log(date('M d H:i:s ') . (string) $e);
            $object->status = 20042;
            return $object;
        }
    }


    /**
     * Method to add a new picture.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function addPicture($p)
    {
        $p['id'] = 1;

        // Finding a free picture ID
        while (True) {
            if (!isset($this->pictures[$p['id']])) {
                break;
            } else {
                $p['id'] = $p['id'] + 1;
            }
        }

        // Adding the picture
        try {
            $this->pictures[$p['id']] = new Picture($p, $p['id']);
            return $this->save();
        } catch (Exception $e) {
            // Failed to create the picture
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?pic=' . $p['id'] . ' ' . $GLOBALS['messages'][20017]);
            error_log(date('M d H:i:s ') . (string) $e);
            return 20017;
        }
    }

    /**
     * Method to delete a network.
     *
     * @param   int     $i                  Network ID
     * @return  int                         0 if OK
     */
    public function deleteNetwork($i)
    {
        
        if (isset($this->networks[$i])) {
            // Unlink node interfaces
            foreach ($this->getNodes() as $node_id => $node) {
                foreach ($node->getInterfaces() as $interface_id => $interface) {
                    if ($interface->getNetworkId() == $i) {
                        $node->unlinkInterface($interface_id, true);
                    }
                }
            }
            unset($this->networks[$i]);
        } else {
            error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?net=' . $i . ' ' . $GLOBALS['messages'][20023]);
        }
        return $this->save();

    }

    /**
     * Method to delete a node.
     *
     * @param   int     $i                  Node ID
     * @return  int                         0 if OK
     */
    public function deleteNode($i)
    {
        if (isset($this->nodes[$i])) {
            $node = $this->nodes[$i];
            if (!empty($node->getSerials())) {
                // Node has configured Serial interfaces
                foreach ($node->getSerials() as $interface_id => $interface) {
                    if ($interface->getRemoteId() != 0) {
                        try {
                            // Serial interface is configured, unlink remote node
                            $rc = $this->nodes[$interface->getRemoteId()]->unlinkInterface($interface->getRemoteIf());
                            if ($rc !== 0) {
                                error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?node=' . $interface->getRemoteId() . ' ' . $GLOBALS['messages'][20035]);
                            }
                        } catch (Exception $e) {
                        }
                    }
                }
            }

            // Ethernet interfaces bind to shared <network> objects (each endpoint
            // keeps its own <interface network_id=…>). A plain node-delete used to
            // drop only this node's interfaces, leaving the network object AND every
            // neighbor's network_id dangling — so neighbors kept showing the deleted
            // node's link (stale "e0/2 -> 9800CL Gi2" entries in Add-connection).
            // For each hidden point-to-point network this node touches (visibility 0,
            // auto-created for a node<->node link), tear the whole network down:
            // deleteNetwork() unlinks the surviving endpoint(s) and removes the orphan
            // network object — exactly what a manual link-delete does. User-created
            // shared networks (visibility 1, e.g. "Net 1") are left intact so their
            // other members stay connected.
            $p2p_nets = array();
            foreach ($node->getEthernets() as $interface) {
                $net_id = $interface->getNetworkId();
                if ($net_id !== '' && $net_id != 0 && isset($this->networks[$net_id])
                    && $this->networks[$net_id]->getVisibility() == 0) {
                    $p2p_nets[$net_id] = true;
                }
            }
            foreach (array_keys($p2p_nets) as $net_id) {
                $this->deleteNetwork($net_id);
            }

            // Delete the node
            $result = $node->delNodeSession();

            if (!$result['result']) throw new Exception(get($result['data'], ''));
            unset($this->nodes[$i]);
        } else {
            error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?node=' . $i . ' ' . $GLOBALS['messages'][20024]);
        }
        return $this->save();
    }

    /**
     * Method to delete a text object.
     *
     * @param   int     $i                  Object ID
     * @return  int                         0 if OK
     */
    public function deleteTextObject($i)
    {
        if (isset($this->textobjects[$i])) {
            unset($this->textobjects[$i]);
        } else {
            error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?obj=' . $i . ' ' . $GLOBALS['messages'][20043]);
        }
        return $this->save();
    }

    /**
     * Method to delete a picture.
     *
     * @param   int     $i                  Picture ID
     * @return  int                         0 if OK
     */
    public function deletePicture($i)
    {
        if (isset($this->pictures[$i])) {
            unset($this->pictures[$i]);
        } else {
            error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?pic=' . $i . ' ' . $GLOBALS['messages'][20018]);
        }
        return $this->save();
    }

    /**
     * Method to add or replace the lab metadata.
     * Editable attributes:
     * - author
     * - description
     * - version
     * If an attribute is set and is valid, then it will be used. If an
     * attribute is not set, then the original is maintained. If in attribute
     * is set and empty '', then the current one is deleted.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 means ok
     */
    public function edit($p)
    {
        $modified = False;

        if (isset($p['name']) && !checkLabFilename($p['name'] . '.unl')) {
            // Name is not valid, ignored
            error_log(date('M d H:i:s ') . 'WARNING: ' . $GLOBALS['messages'][20038]);
        } else if (isset($p['name'])) {
            $this->name = $p['name'];
            $modified = True;
        }

        if (isset($p['author']) && $p['author'] === '') {
            // Author is empty, unset the current one
            unset($this->author);
            $modified = True;
        } else if (isset($p['author'])) {
            $this->author = htmlspecialchars($p['author'], ENT_DISALLOWED, 'UTF-8', TRUE);
            $modified = True;
        }

        if (isset($p['body']) && $p['body'] === '') {
            // Body is empty, unset the current one
            unset($this->body);
            $modified = True;
        } else if (isset($p['body'])) {
            $this->body = htmlspecialchars($p['body'], ENT_DISALLOWED, 'UTF-8', TRUE);
            $modified = True;
        }

        if (isset($p['description']) && $p['description'] === '') {
            // Description is empty, unset the current one
            unset($this->description);
            $modified = True;
        } else if (isset($p['description'])) {
            $this->description = htmlspecialchars($p['description'], ENT_DISALLOWED, 'UTF-8', TRUE);
            $modified = True;
        }

        if (isset($p['version']) && $p['version'] === '') {
            // Version is empty, unset the current one
            unset($this->version);
            $modified = True;
        } else if (isset($p['version']) && (int) $p['version'] < 0) {
            // Version is not valid, ignored
            error_log(date('M d H:i:s ') . 'WARNING: ' . $GLOBALS['messages'][30008]);
        } else if (isset($p['version'])) {
            $this->version = (int) $p['version'];
            $modified = True;
        }
        if (isset($p['scripttimeout'])) {
            $this->scripttimeout = (int) $p['scripttimeout'];
            $modified = True;
        }
        if (isset($p['countdown'])) {
            $this->countdown = (int) $p['countdown'];
            $modified = True;
        }
        if (isset($p['openable'])) {
            $this->openable = (int) $p['openable'];
            $modified = True;
        }
        if (isset($p['joinable'])) {
            $this->joinable = (int) $p['joinable'];
            $modified = True;
        }
        if (isset($p['editable'])) {
            $this->editable = (int) $p['editable'];
            $modified = True;
        }
        if (isset($p['openable_emails'])) {
            $this->openable_emails = (array) $p['openable_emails'];
            $modified = True;
        }
        if (isset($p['joinable_emails'])) {
            $this->joinable_emails = (array) $p['joinable_emails'];
            $modified = True;
        }
        if (isset($p['editable_emails'])) {
            $this->editable_emails = (array) $p['editable_emails'];
            $modified = True;
        }

        if ($modified) {
            // At least an attribute is changed
            return $this->save();
        } else {
            // No attribute has been changed
            error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][20030]);
            return 20030;
        }
    }

    /**
     * Method to edit a network.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function editNetwork($p)
    {
        if (!isset($this->networks[$p['id']])) {
            // Network not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?net=' . $p['id'] . ' ' . $GLOBALS['messages'][20023]);
            return 20023;
        } else if ($this->networks[$p['id']]->edit($p) === 0) {
            if (isset($p['save']) && $p['save'] === 0) {
                return 0;
            } else {
                return $this->save();
            }
        } else {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?net=' . $p['id'] . ' ' . $GLOBALS['messages'][20025]);
            return False;
        }
    }

    /**
     * Method to edit a node.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function editNode($p)
    {
        if (!isset($this->nodes[$p['id']])) {
            // Node not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $p['id'] . ' ' . $GLOBALS['messages'][20024]);
            return 20024;
        } else {
            $this->nodes[$p['id']]->edit($p);

            if (isset($p['save']) && $p['save'] === 0) {
                return 0;
            } else {
                return $this->save();
            }
        }
    }

    /**
     * Method to edit a text object.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function editTextObject($p)
    {
        if (!isset($this->textobjects[$p['id']])) {
            // Picture not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?obj=' . $p['id'] . ' ' . $GLOBALS['messages'][20043]);
            return 20043;
        } else if ($this->textobjects[$p['id']]->edit($p) === 0) {
            if (isset($p['save']) && $p['save'] === 0) {
                return 0;
            } else {
                return $this->save();
            }
        } else {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?obj=' . $p['id'] . ' ' . $GLOBALS['messages'][20044]);
            return False;
        }
    }

    /**
     * Method to edit a picture.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 if OK
     */
    public function editPicture($p)
    {
        if (!isset($this->pictures[$p['id']])) {
            // Picture not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?pic=' . $p['id'] . ' ' . $GLOBALS['messages'][20018]);
            return 20018;
        } else if ($this->pictures[$p['id']]->edit($p) == 0) {
            return $this->save();
        } else {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?pic=' . $p['id'] . ' ' . $GLOBALS['messages'][20019]);
            return False;
        }
    }

    /**
     * Method to get lab author.
     *
     * @return  string                      Lab author or False if not set
     */
    public function getAuthor()
    {
        if (isset($this->author)) {
            return $this->author;
        } else {
            // By default return an empty string
            return '';
        }
    }

    /**
     * Method to get lab body.
     *
     * @return  string                      Lab body or False if not set
     */
    public function getBody()
    {
        if (isset($this->body)) {
            return $this->body;
        } else {
            // By default return an empty string
            return '';
        }
    }

    /**
     * Method to get lab description.
     *
     * @return  string                      Lab description or False if not set
     */
    public function getDescription()
    {
        if (isset($this->description)) {
            return $this->description;
        } else {
            // By default return an empty string
            return '';
        }
    }

    /**
     * Method to get lab filename.
     *
     * @return  string                      Lab filename
     */
    public function getFilename()
    {
        return $this->filename;
    }

    /**
     * Method to get free network ID.
     *
     * @return  int                         Free network ID
     */
    public function getFreeNetworkId()
    {
        $id = 1;

        // Finding a free network ID
        while (True) {
            if (!isset($this->networks[$id])) {
                return $id;
            }
            $id = $id + 1;
        }
    }

    /**
     * Method to get free node ID.
     *
     * @return  int                         Free node ID
     */
    public function getFreeNodeId()
    {
        $id = 1;

        // Finding a free node ID
        while (True) {
            if (!isset($this->nodes[$id])) {
                return $id;
            }
            $id = $id + 1;
        }
    }

    /**
     * Method to get lab ID.
     *
     * @return  string                      Lab ID
     */
    public function getId()
    {
        return $this->id;
    }

    /**
     * Method to get lab name.
     *
     * @return  string                      Lab name
     */
    public function getName()
    {
        return $this->name;
    }

    /**
     * Method to get all lab networks.
     *
     * @return  Array                       Lab networks
     */
    public function getNetworks()
    {
        if (!empty($this->networks)) {
            return $this->networks;
        } else {
            // By default return an empty array
            return array();
        }
    }

    /**
     * Method to get all lab nodes.
     *
     * @return  Array                       Lab nodes
     */
    public function getNodes()
    {
        if (!empty($this->nodes)) {
            return $this->nodes;
        } else {
            // By default return an empty array
            return array();
        }
    }

    public function getRunningNodes()
    {
        if ($this->runningNodes == null) {
            $runningNodes = [];
            foreach ($this->nodes as $node_id => $node) {
                $state = $node->getStatus();
                if ($state == 2 || $state == 3 || $state == 7) {
                    $runningNodes[$node_id] = $node;
                }
            }
            $this->runningNodes = $runningNodes;
        }
        return $this->runningNodes;
    }

    public function isRunning()
    {
        $db = checkDatabase();
        $query = 'SELECT lab_session_id FROM lab_sessions WHERE lab_session_lid = :lab_session_lid';
        $statement = $db->prepare($query);
        $statement->execute(['lab_session_lid' => $this->getId()]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        return isset($result[0]);
    }

    /**
     * Method to get all lab objects.
     *
     * @return  Array                       Lab objects
     */
    public function getTextObjects()
    {
        if (!empty($this->textobjects)) {
            return $this->textobjects;
        } else {
            // By default return an empty array
            return array();
        }
    }

    /**
     * Method to get all lab pictures.
     *
     * @return  Array                       Lab pictures
     */
    public function getPictures()
    {
        if (!empty($this->pictures)) {
            return $this->pictures;
        } else {
            // By default return an empty array
            return array();
        }
    }

    /* Method to get all lab pictures.
         *
         * @return  Array                       Lab pictures
         */
    public function getPictureMapped($id, $html5)
    {
        error_log(date('M d H:i:s ') . $id . ' - ' . $html5);

        if (!empty($this->pictures[$id])) {
            $curpic = $this->pictures[$id];
            $curmap = $curpic->getMap();
            $curname = $curpic->getName();
            preg_match_all("|(.*href=')(.*NODE)(.*)(}}.*)|U", $curmap, $out, PREG_PATTERN_ORDER);
            $curmap = "";
            for ($i = 0; $i < count($out[0]); $i++) {
                $curnode = $this->getNodes()[$out[3][$i]];
                if ($html5 == 1) {
                    $curmap = $curmap . $out[1][$i] . $curnode->getConsoleUrl($html5) . '\' TARGET=\'' . $curnode->getName() . '\'>';
                } else {
                    $curmap = $curmap . $out[1][$i] . $curnode->getConsoleUrl($html5) . '\'>';
                }
            }
            $curpic->edit(array('name' => $curname, 'map' => $curmap));
            return $curpic;
        } else {
            // By default return an empty array
            return array();
        }
    }


    /**
     * Method to get lab path.
     *
     * @return  string                      Lab absolute path
     */
    public function getPath()
    {
        return $this->path;
    }

    /**
     * Method to get tenant ID.
     *
     * @return  int                         Tenant ID
     */
    public function getTenant()
    {
        return $this->tenant;
    }


    public function getHost()
    {
        if (isset($this->lab_session[LAB_SESSION_POD])) return $this->lab_session[LAB_SESSION_POD];
        return null;
    }

    /**
     * Method to get lab version.
     *
     * @return  string                      Lab version or False if not set
     */
    public function getVersion()
    {
        if (isset($this->version)) {
            return $this->version;
        } else {
            // By default return 0
            return 0;
        }
    }
    /**
     * Method to get lab scripttimeout
     *
     * @return  int                      Lab version or False if not set
     */
    public function getScriptTimeout()
    {
        if (isset($this->scripttimeout)) {
            return (int) $this->scripttimeout;
        } else {
            // By default return 0
            return 0;
        }
    }

    /** 
     * Method to get lab lock status
     *
     * @return  int Lab lock status 1=lock O=unlock
     */
    public function getPassword()
    {
        return $this->password;
    }

    public function isLock()
    {
        if (!isset($this->password) || $this->password == '') return 0;
        if (session_status() == PHP_SESSION_NONE) session_start();
        if (isset($_SESSION['key' . $this->id])) return 0;
        return 1;
    }

    /**
     * Method to connect a node to a network or to a remote node.
     *
     * @param   int     $n                  Node ID
     * @param   Array   $p                  Array of interfaces to link (index = interface_id, value = remote)
     * @return  int                         0 means ok
     */
    public function connectNode($n, $p)
    {
        if (!isset($this->nodes[$n])) {
            // Node not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $n . ' ' . $GLOBALS['messages'][20032]);
            return 20032;
        }

        $result = 0;

        foreach ($p as $interface_id => $interface_link) {
            if ($interface_link !== '') {
                // Interface must be configured
                $i = array();
                $i['id'] = $interface_id;

                if (strpos($interface_link, ':') === False) {
                    // No ':' found -> simple Ethernet interface
                    if (isset($this->getNetworks()[$interface_link])) {
                        // Network exists
                        $i['network_id'] = $interface_link;
                        $i['networks'] = $this->getNetworks();
                        // Link the interface
                        if ($this->nodes[$n]->linkInterface($i, true) !== 0) {
                            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $n . ' ' . $GLOBALS['messages'][20034]);
                            return 20034;
                        }

                    } else {
                        error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?net=' . $interface_link . ' ' . $GLOBALS['messages'][20033]);
                        return 20033;
                    }
                } else {
                    // ':' found -> should be Serial interface
                    $remote_id = substr($interface_link, 0, strpos($interface_link, ':'));
                    $remote_if = substr($interface_link, strpos($interface_link, ':') + 1);

                    // Before connect, we need to unlink remote node of both source and destination node
                    $node = $this->nodes[$n];  // Source node
                    if (isset($node->getSerials()[$interface_id]) && $node->getSerials()[$interface_id]->getRemoteId() !== 0) {
                        // Serial interfaces was previously connected, need to unlink remote node
                        try {
                            $rc = $this->nodes[$node->getSerials()[$interface_id]->getRemoteId()]->unlinkInterface($node->getSerials()[$interface_id]->getRemoteIf());
                            if ($rc !== 0) {
                                error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . $GLOBALS['messages'][20035]);
                            }
                        } catch (Exception $e) {
                        }
                    }
                    $node = $this->nodes[$remote_id];  // Destination node
                    if (isset($node->getSerials()[$remote_if]) && $node->getSerials()[$remote_if]->getRemoteId() !== 0) {
                        // Serial interfaces was previously connected, need to unlink remote node
                        try {
                            $rc = $this->nodes[$node->getSerials()[$remote_if]->getRemoteId()]->unlinkInterface($node->getSerials()[$remote_if]->getRemoteIf());
                            if ($rc !== 0) {
                                error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . $GLOBALS['messages'][20035]);
                            }
                        } catch (Exception $e) {
                        }
                    }

                    // Connect local to remote: Local $n:$interface_id -> Remote $remote_id:$remote_if
                    $i['id'] = $interface_id;
                    $i['remote_id'] = $remote_id;
                    $i['remote_if'] = $remote_if;

                    // Link the interface
                    if ($this->nodes[$n]->linkInterface($i) !== 0) {
                        error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $n . ' ' . $GLOBALS['messages'][20034]);
                        return 20034;
                    }

                    // Connect remote to local: Local $n:$interface_id <- Remote $remote_id:$remote_if
                    $i = array();
                    $i['id'] = $remote_if;
                    $i['remote_id'] = $n;
                    $i['remote_if'] = $interface_id;

                    // Link the interface
                    if ($this->nodes[$remote_id]->linkInterface($i) !== 0) {
                        error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $remote_id . ' ' . $GLOBALS['messages'][20034]);
                        return 20034;
                    }

                   
                    $result = 1;
                    
                }
            } else {
                // Interface must be deconfigured
                $node = $this->nodes[$n];
                if (isset($node->getSerials()[$interface_id]) && $node->getSerials()[$interface_id]->getRemoteId() !== 0) {
                    // Serial interfaces was previously connected, need to unlink remote node
                    try {
                        $rc = $this->nodes[$node->getSerials()[$interface_id]->getRemoteId()]->unlinkInterface($node->getSerials()[$interface_id]->getRemoteIf());
                        if ($rc !== 0) {
                            error_log(date('M d H:i:s ') . 'WARNING: ' . $this->path . '/' . $this->filename . '?node=' . $node->getSerials()[$interface_id]->getRemoteId() . ' ' . $GLOBALS['messages'][20035]);
                        }
                    } catch (Exception $e) {
                    }
                }

                // Now deconfigure local interface
                $this->nodes[$n]->unlinkInterface($interface_id, true);
                $result = 1;
            }
        }
        $this->save();

        return $result;

        /** =============== */
    }


    /**
     * Method to Lock  lab 
     *
     * @return  int                         0 means ok
     */
    public function lockLab($pass = null)
    {
        if ($pass != null) {
            $this->password = md5($pass);
            $rc = $this->save();
        }
        if (session_status() == PHP_SESSION_NONE) session_start();
        unset($_SESSION['key' . $this->id]);
        return 0;
    }

    /**
     * Method to Unlock  lab
     *
     * @return  int                         0 means ok
     */
    public function unlockLab($pass, $clearpass = false)
    {
        if (!isset($this->password) || $this->password == '') return 0;
        if (md5($pass) == $this->password) {
            if ($clearpass) {
                $this->password = '';
                $rc = $this->save();
                return $rc;
            } else {
                if (session_status() == PHP_SESSION_NONE) session_start();
                $_SESSION['key' . $this->id] = true;
                return 0;
            }
        } else throw new Exception('Password is wrong');
    }

    /**
     * Method to save a lab into a file.
     *
     * @return  int                         0 means ok
     */
    public function save()
    {
        // TODO should lock file before editing it
        // XML header is splitted because of a highlight syntax bug on VIM
        $xml = new SimpleXMLElement('<?xml version="1.0" encoding="UTF-8" standalone="yes"?' . '><lab></lab>');
        $xml->addAttribute('name', $this->name);
        $xml->addAttribute('id', $this->id);

        if (isset($this->version)) $xml->addAttribute('version', $this->version);
        if (isset($this->scripttimeout)) $xml->addAttribute('scripttimeout', $this->scripttimeout);
        if (isset($this->password)) $xml->addAttribute('password', $this->password);
        if (isset($this->author)) $xml->addAttribute('author', $this->author);
        if (isset($this->description)) $xml->addChild('description', $this->description);
        if (isset($this->body)) $xml->addChild('body', $this->body);

        if (isset($this->countdown)) $xml->addAttribute('countdown', $this->countdown);
        if (isset($this->darkmode)) $xml->addAttribute('darkmode', $this->darkmode);
        if (isset($this->mode3d)) $xml->addAttribute('mode3d', $this->mode3d);
        if (isset($this->nogrid)) $xml->addAttribute('nogrid', $this->nogrid);
        if (isset($this->joinable)) $xml->addAttribute('joinable', $this->joinable);
        if (isset($this->joinable_emails)) $xml->addAttribute('joinable_emails', implode(',', $this->joinable_emails));
        if (isset($this->openable)) $xml->addAttribute('openable', $this->openable);
        if (isset($this->openable_emails)) $xml->addAttribute('openable_emails', implode(',', $this->openable_emails));
        if (isset($this->editable)) $xml->addAttribute('editable', $this->editable);
        if (isset($this->editable_emails)) $xml->addAttribute('editable_emails', implode(',', $this->editable_emails));
        if (isset($this->multi_config_active)) $xml->addAttribute('multi_config_active', $this->multi_config_active);

        // Add topology
        if (!empty($this->getNodes()) || !empty($this->getNetworks())) {
            $xml->addChild('topology');

            // Add nodes
            if (!empty($this->getNodes())) {
                $xml->topology->addChild('nodes');
                foreach ($this->getNodes() as $node_id => $node) {
                    $d = $xml->topology->nodes->addChild('node');
                    $d->addAttribute('id', $node_id);
                    $d->addAttribute('type', $node->getNType());
                    $d->addAttribute('template', $node->getTemplate());


                    $options =  $node->getOptions();
                    foreach ($options as $key => $value) {
                        $d->addAttribute($key, get($value, ''));
                    }

                    // Add Ethernet interfaces
                    foreach ($node->getEthernets() as $interface_id => $interface) {
                        if ($interface->getNetworkId() > 0 && isset($this->getNetworks()[$interface->getNetworkId()])) {

                            $e = $d->addChild('interface');
                            $e->addAttribute('id', $interface_id);
                            $e->addAttribute('name', $interface->getName());
                            $e->addAttribute('type', $interface->getNType());
                            $e->addAttribute('network_id', $interface->getNetworkId());
                            $e->addAttribute('vid', $interface->getVlanId());
                            if (method_exists($interface, 'getVlanMode')) {
                                $e->addAttribute('vlanmode', $interface->getVlanMode());
                                $e->addAttribute('vlans', $interface->getVlans());
                            }
                            $style = $interface->getInterfaceStyle();
                            foreach ($style as $key => $value) {
                                $e->addAttribute($key, get($value, ''));
                            }
                        }
                    }

                    // Add Serial interfaces
                    foreach ($node->getSerials() as $interface_id => $interface) {
                        try {
                            if ($interface->getRemoteId() > 0 && isset($this->getNodes()[$interface->getRemoteId()])) {
                                $e = $d->addChild('interface');
                                $e->addAttribute('id', $interface_id);
                                $e->addAttribute('type', $interface->getNType());
                                $e->addAttribute('name', $interface->getName());
                                $e->addAttribute('remote_id', $interface->getRemoteId());
                                $e->addAttribute('remote_if', $interface->getRemoteIf());

                                $style = $interface->getInterfaceStyle();
                                foreach ($style as $key => $value) {
                                    $e->addAttribute($key, get($value, ''));
                                }
                            }
                        } catch (Exception $e) {
                        }
                    }
                }
            }


            // Add networks
            if (!empty($this->getNetworks())) {
                $xml->topology->addChild('networks');
                foreach ($this->getNetworks() as $network_id => $network) {
                    $n = $xml->topology->networks->addChild('network');
                    $n->addAttribute('id', $network_id);
                    $n->addAttribute('type', $network->getNType());
                    $n->addAttribute('name', $network->getName());
                    $n->addAttribute('left', $network->getLeft());
                    $n->addAttribute('top', $network->getTop());
                    $n->addAttribute('visibility', $network->getVisibility());
                    $n->addAttribute('icon', $network->getIcon());
                    $n->addAttribute('size', $network->getSize());
                    $n->addAttribute('smart', $network->getsmart());
                    $n->addAttribute('vlan8021ad', $network->getvlan8021ad());
                    // soft-router config (forward-compatible: only persists
                    // once the base Network class is vendored with getRouterCfg
                    // — v1 keeps config broker-side per run).
                    if (method_exists($network, 'getRouterCfg')) {
                        $n->addAttribute('rtr_cfg', $network->getRouterCfg());
                    }
                }
            }
        }

        // Add text objects
        $objects = False;
        if (!empty($this->getTextObjects())) {
            if ($objects == False) {
                $xml->addChild('objects');
                $objects = True;
            }
            $xml->objects->addChild('textobjects');
        }
        foreach ($this->getTextObjects() as $textobject_id => $textobject) {
            $p = $xml->objects->textobjects->addChild('textobject');
            $p->addAttribute('id', $textobject_id);
            $p->addAttribute('name', $textobject->getName());
            $p->addAttribute('type', $textobject->getNType());
            $p->addChild('data', $textobject->getData());
        }

        $objects = False;
        if (!empty($this->getLineObjects())) {
            if ($objects == False) {
                $xml->addChild('objects');
                $objects = True;
            }
            $xml->objects->addChild('lineobjects');
        }
        foreach ($this->getLineObjects() as $lineobject_id => $lineobject) {
            $p = $xml->objects->lineobjects->addChild('lineobject');
            $p->addAttribute('id', $lineobject_id);
            if (isset($lineobject['width'])) $p->addAttribute('width', $lineobject['width']);
            if (isset($lineobject['linestyle'])) $p->addAttribute('linestyle', $lineobject['linestyle']);
            if (isset($lineobject['paintstyle'])) $p->addAttribute('paintstyle', $lineobject['paintstyle']);
            if (isset($lineobject['color'])) $p->addAttribute('color', $lineobject['color']);
            if (isset($lineobject['label'])) $p->addAttribute('label', $lineobject['label']);
            if (isset($lineobject['endsym'])) $p->addAttribute('endsym', $lineobject['endsym']);
            if (isset($lineobject['startsym'])) $p->addAttribute('startsym', $lineobject['startsym']);
            if (isset($lineobject['x1'])) $p->addAttribute('x1', $lineobject['x1']);
            if (isset($lineobject['x2'])) $p->addAttribute('x2', $lineobject['x2']);
            if (isset($lineobject['y1'])) $p->addAttribute('y1', $lineobject['y1']);
            if (isset($lineobject['y2'])) $p->addAttribute('y2', $lineobject['y2']);
            if (isset($lineobject['linecfg'])) $p->addAttribute('linecfg', $lineobject['linecfg']);
        }

        //=============================

        // Add pictures
        $objects = False;
        if (!empty($this->getPictures())) {
            if ($objects == False) {
                $xml->addChild('objects');
                $objects = True;
            }
            $xml->objects->addChild('pictures');
        }
        foreach ($this->getPictures() as $picture_id => $picture) {
            $p = $xml->objects->pictures->addChild('picture');
            $p->addAttribute('id', $picture_id);
            $p->addAttribute('name', $picture->getName());
            $p->addAttribute('type', $picture->getNType());
            $p->addAttribute('width', $picture->getWidth());
            $p->addAttribute('height', $picture->getHeight());
            $p->addChild('data', base64_encode($picture->getData()));
            $p->addChild('map', htmlspecialchars($picture->getMap()));
        }

        /** ====PNETLAB workbook===== */
        if (isset($this->workbooks)) {
            $xml->addChild('workbooks');
            foreach ($this->workbooks as $workbook) {
                $wb = $xml->workbooks->addChild('workbook');
                $wb->addAttribute('id', $workbook->name);
                $wb->addAttribute('type', $workbook->type);
                $wb->addAttribute('weight', $workbook->weight);
                if (isset($workbook->kind) && $workbook->kind !== null && $workbook->kind !== '') {
                    $wb->addAttribute('kind', $workbook->kind);
                }
                if (isset($workbook->content)) {
                    if ($workbook->type == 'pdf') {
                        $wb->addChild('content', $workbook->content);
                    } else {
                        $content = $wb->addChild('content');
                        foreach ($workbook->content as $page) {
                            $content->addChild('page', htmlspecialchars($page, ENT_QUOTES | ENT_XML1, 'UTF-8'));
                        }
                    }
                }

                if (isset($workbook->menu)) {
                    $wb->addChild('menu', json_encode($workbook->menu));
                }
            }
        }
        /** =========================== */


        // Well format the XML
        $dom = new DOMDocument('1.0');
        $dom->preserveWhiteSpace = false;
        $dom->formatOutput = true;
        $xmlLoaded = $dom->loadXML($xml->asXML());
        // Never replace a lab with XML that failed serialization.
        if ($xmlLoaded === false || $dom->documentElement === null || $dom->documentElement->nodeName !== 'lab') {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][20047]);
            return 20047;
        }
        //===================PNETLAB=====================
        $labContentXML = $dom->saveXML();

        // if ($this->isEncrypt) {
        //     $labContentXML = $this->crypt_lab($labContentXML, $this->labId, 'e');
        // }
        //========================================
        // Write to file
        // $tmp = $this -> path.'/'.$this -> name.'.swp';

        $tmp = tempnam($this->path, $this->name . '.swp');
        chown($tmp, "www-data");
        chmod($tmp, 0644);
        $old = $this->path . '/' . $this->filename;
        $dst = $this->path . '/' . $this->name . '.unl';
        $fp = fopen($tmp, 'w');
        $trylock = 60;
        while ($trylock > 0) {
            flock($fp, LOCK_EX) && $trylock = 0;
            $trylock -= 1;
            usleep(100000);
        }

        if ($trylock == 0 || fwrite($fp, $labContentXML) !== strlen($labContentXML)) {
            // Failed to write
            fclose($fp);
            unlink($tmp);
            error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][20027]);
            return 20027;
        } else {

            // Write OK — make it durable before any rename: flush PHP buffers,
            // then fsync so the bytes hit the disk (crash-safe), then close.
            fflush($fp);
            fsync($fp);
            fclose($fp);

            if ($old != $dst && is_file($dst)) {
                // Should rename the lab, but destination file already exists
                unlink($tmp);
                error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][20039]);
                return 20039;
            }
            // rename() atomically replaces $dst — no pre-unlink of the old file
            // (the old pre-unlink left a window where a crash lost the lab).
            // Residual (documented): the containing directory is not fsync'd
            // (PHP cannot fopen a directory) — the rename may not be journaled
            // yet on power loss, but the file is never missing/truncated.
            if (!rename($tmp, $dst)) {
                // Cannot move $tmp to $dst
                unlink($tmp);
                error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][20029]);
                return 20029;
            }
            if ($old != $dst && is_file($old) && !@unlink($old)) {
                // Rename-the-lab case: new file is safely in place; failing to
                // remove the old name is non-fatal — warn and still succeed.
                error_log(date('M d H:i:s ') . 'WARNING: ' . $GLOBALS['messages'][20028]);
            }
        }
        //error_log(date('M d H:i:s ') . 'DEBUG: lab saved');
        return 0;
    }

    /**
     * Method to set a new lab_id
     *
     * @return  void
     */
    public function setId()
    {
        $this->id = genUuid();
        $this->save();
    }



    /**
     * Method to set startup-config for a specific node
     *
     * @param   int     $node_id            Node ID
     * @param   string  $config_data         Binary config
     * @return  int                         0 means ok
     */
    public function setNodeConfigData($node_id, $config_data)
    {
        if (!isset($this->nodes[$node_id])) {
            // Node not found
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $node_id . ' ' . $GLOBALS['messages'][20024]);
            return 20024;
        } else if ($this->nodes[$node_id]->setConfigData($config_data) === 0) {
            return $this->save();
        } else {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $this->path . '/' . $this->filename . '?node=' . $node_id . ' ' . $GLOBALS['messages'][20036]);
            return False;
        }
    }

    /**Multi config*/

    private $multi_config_active = '';

    /**
     *
     * @return the $multi_config_active
     */
    public function getMulti_config_active()
    {
        return $this->multi_config_active;
    }

    /**
     *
     * @param string $multi_config_active            
     */
    public function setMulti_config_active($multi_config_active)
    {
        $this->multi_config_active = $multi_config_active;
        // foreach($this->nodes as $node){
        //     $node->updateStartUpConfig();
        // }
    }


    /** Workbook */
    private $workbooks;
    private $eveImportStats = array(
        'total' => 0,
        'imported' => 0,
        'skipped' => 0,
    );

    /**
     * Merge parsed EVE tasks into the in-memory workbook set.
     *
     * This deliberately does not call save() or addTask(): imported EVE
     * tasks already contain their content, and imports must bypass the native
     * interactive task-creation cap.
     *
     * @param array $parsed Complete result from unlTasksParseEve().
     * @return array Import totals with parser- and import-level skips.
     */
    public function importEveTasks(array $parsed): array
    {
        $tasks = isset($parsed['tasks']) && is_array($parsed['tasks'])
            ? $parsed['tasks'] : [];
        $parserSkipped = isset($parsed['skipped']) && is_array($parsed['skipped'])
            ? $parsed['skipped'] : [];

        $stats = [
            'total' => count($tasks) + count($parserSkipped),
            'imported' => 0,
            'skipped' => count($parserSkipped),
        ];

        if (!empty($tasks) && !isset($this->workbooks)) {
            $this->workbooks = [];
        }

        foreach ($parserSkipped as $skipped) {
            $id = isset($skipped['id']) ? (string) $skipped['id'] : '';
            $name = isset($skipped['name']) ? (string) $skipped['name'] : '';
            $reason = isset($skipped['reason']) ? (string) $skipped['reason'] : 'parser_skipped';
            error_log('EVE task import skipped: id=' . $id . ' name=' . $name . ' reason=' . $reason);
        }

        $documentWeight = 0;
        foreach ($tasks as $task) {
            $id = isset($task['id']) ? (string) $task['id'] : '';
            $name = isset($task['name']) ? (string) $task['name'] : '';
            if ($name === '') {
                $stats['skipped']++;
                error_log('EVE task import skipped: id=' . $id . ' name=' . $name . ' reason=missing_name');
                $documentWeight++;
                continue;
            }

            $html = isset($task['html']) ? (string) $task['html'] : '';

            // Sanitize before any collision comparison. Native task content is
            // already sanitized at write time, so this is the canonical form
            // used for the no-op equality check below.
            $sanitized = sanitizeTaskHtml($html);
            if (trim(strip_tags($sanitized)) === '') {
                $stats['skipped']++;
                error_log('EVE task import skipped: id=' . $id . ' name=' . $name . ' reason=trivial_output');
                $documentWeight++;
                continue;
            }

            $resolvedName = $name;
            $suffix = 0;
            while (true) {
                $collision = null;
                foreach ($this->workbooks as $workbook) {
                    if (isset($workbook->name) && (string) $workbook->name === $resolvedName) {
                        $collision = $workbook;
                        break;
                    }
                }

                if ($collision === null) {
                    break;
                }

                $existingHtml = '';
                if (isset($collision->content)) {
                    if (is_array($collision->content)) {
                        $existingHtml = isset($collision->content[0])
                            ? (string) $collision->content[0] : '';
                    } else {
                        $existingHtml = (string) $collision->content;
                    }
                }

                if ($suffix === 0 && isset($collision->kind) && $collision->kind === 'task'
                    && $existingHtml === $sanitized) {
                    $stats['skipped']++;
                    error_log('EVE task import skipped: id=' . $id . ' name=' . $name . ' reason=identical_content');
                    $resolvedName = null;
                    break;
                }

                $suffix++;
                $resolvedName = $name . ' (imported' . ($suffix > 1 ? ' ' . $suffix : '') . ')';
            }

            if ($resolvedName !== null) {
                $this->workbooks[] = (object) [
                    'name' => $resolvedName,
                    'type' => 'html',
                    'weight' => $documentWeight,
                    'kind' => 'task',
                    'content' => [$sanitized],
                ];
                $stats['imported']++;
            }

            $documentWeight++;
        }

        $this->eveImportStats = $stats;
        return $stats;
    }

    /**
     * Stats from the EVE task import performed during construction.
     *
     * @return array Total, imported, and skipped task counts.
     */
    public function getEveImportStats(): array
    {
        return [
            'total' => isset($this->eveImportStats['total']) ? (int) $this->eveImportStats['total'] : 0,
            'imported' => isset($this->eveImportStats['imported']) ? (int) $this->eveImportStats['imported'] : 0,
            'skipped' => isset($this->eveImportStats['skipped']) ? (int) $this->eveImportStats['skipped'] : 0,
        ];
    }

    public function getWorkbook($name = null)
    {
        if (isset($name) && $name != '') {
            if (!isset($this->workbooks)) throw new Exception('No workbook created');
            $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
                return $item->name == $name;
            });

            if ($workbook === false) throw new Exception('Workbook not found');

            $workbook = $this->workbooks[$workbook];

            if ($workbook->type == 'pdf') {
                if (preg_match_all('/data:([^;]+);base64,(.*)/', $workbook->content, $match, PREG_SET_ORDER, 0)) {
                    $pdf_decoded = base64_decode($match[0][2]);
                    if (session_status() == PHP_SESSION_NONE) session_start();
                    $_SESSION[$workbook->name] = $pdf_decoded;
                }
            }

            $message = $workbook;
        } else {
            $message = [];
            if (isset($this->workbooks)) {
                foreach ($this->workbooks as $workbook) {
                    $message[] = [
                        'name' => $workbook->name,
                        'type' => $workbook->type,
                        'weight' => $workbook->weight,
                    ];
                }
            }
        }
        return $message;
    }

    /** Lab Tasks: the kind-tagged, single-page view of workbook storage. */
    public function getTasks($name = null)
    {
        if (isset($name) && $name != '') {
            if (!isset($this->workbooks)) throw new Exception('Task not found');

            $task = unl_array_find_key($this->workbooks, function ($item) use ($name) {
                return isset($item->kind) && $item->kind === 'task' && $item->name == $name;
            });

            if ($task === false) throw new Exception('Task not found');

            $task = $this->workbooks[$task];
            $html = '';
            if (isset($task->content)) {
                if (is_array($task->content)) {
                    $html = isset($task->content[0]) ? (string) $task->content[0] : '';
                } else {
                    $html = (string) $task->content;
                }
            }

            // Read-path defense in depth uses the same canonical sanitizer as writes.
            return (object) [
                'name' => $task->name,
                'type' => $task->type,
                'weight' => $task->weight,
                'kind' => 'task',
                'content' => sanitizeTaskHtml($html),
            ];
        }

        $message = [];
        if (isset($this->workbooks)) {
            foreach ($this->workbooks as $workbook) {
                if (isset($workbook->kind) && $workbook->kind === 'task') {
                    $message[] = [
                        'name' => $workbook->name,
                        'type' => $workbook->type,
                        'weight' => $workbook->weight,
                    ];
                }
            }
        }

        usort($message, function ($left, $right) {
            $leftWeight = (int) $left['weight'];
            $rightWeight = (int) $right['weight'];
            return $leftWeight <=> $rightWeight;
        });

        return $message;
    }

    public function addTask($name)
    {
        if (!isset($this->workbooks)) {
            $this->workbooks = [];
        }

        $taskCount = 0;
        foreach ($this->workbooks as $workbook) {
            if (isset($workbook->kind) && $workbook->kind === 'task') {
                $taskCount++;
            }
        }
        if ($taskCount >= 50) {
            throw new Exception('A lab can contain no more than 50 tasks');
        }

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return $item->name == $name;
        });
        if ($workbook !== false) {
            throw new Exception('This task is already existed. Please chose another name');
        }

        $this->workbooks[] = (object) [
            'name' => $name,
            'type' => 'html',
            'weight' => time() . rand(1000, 9999),
            'kind' => 'task',
        ];

        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function delTask($name)
    {
        if (!isset($this->workbooks)) {
            throw new Exception('No task found');
        }

        $task = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return isset($item->kind) && $item->kind === 'task' && $item->name == $name;
        });
        if ($task === false) {
            throw new Exception('Task not found');
        }

        array_splice($this->workbooks, $task, 1);
        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function renameTask($name, $new_name)
    {
        if (!isset($this->workbooks)) {
            throw new Exception('No task found');
        }

        $existing = unl_array_find_key($this->workbooks, function ($item) use ($new_name) {
            return $item->name == $new_name;
        });
        if ($existing !== false) {
            throw new Exception('This task is already existed. Please chose another name');
        }

        $task = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return isset($item->kind) && $item->kind === 'task' && $item->name == $name;
        });
        if ($task === false) {
            throw new Exception('Task not found');
        }

        $this->workbooks[$task]->name = $new_name;
        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function updateTaskContent($name, $html)
    {
        if (!isset($this->workbooks)) throw new Exception('No task found');

        $task = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return isset($item->kind) && $item->kind === 'task' && $item->name == $name;
        });
        if ($task === false) throw new Exception('Task not found');
        $task = $this->workbooks[$task];

        if ((filesize($this->file) + strlen(json_encode($html))) > (100 * 1024 * 1024)) throw new Exception('
                        Lab size must be less than 50M. The large Workbook size will reduce the Lab speed
                    ');

        // The API layer owns sanitization; this method stores its pre-sanitized HTML.
        $task->content = [$html];
        unset($task->menu);

        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function addWorkbook($name, $type)
    {
        if (!isset($this->workbooks)) {
            $this->workbooks = [];
        }

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return $item->name == $name;
        });

        if ($workbook !== false) {
            throw new Exception('This workbook is already existed. Please chose another name');
        }

        $this->workbooks[] = (object) [
            'name' => $name,
            'type' => $type,
            'weight' => time() . rand(1000, 9999),
        ];

        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function delWorkbook($name)
    {
        if (!isset($this->workbooks)) {
            throw new Exception('No workbook found');
        }

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return $item->name == $name;
        });

        if ($workbook === false) {
            throw new Exception('Workbook not found');
        } else {
            array_splice($this->workbooks, $workbook, 1);
        }
        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function editWorkbook($name, $new_name)
    {
        if (!isset($this->workbooks)) {
            throw new Exception('No workbook found');
        }

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($new_name) {
            return $item->name == $new_name;
        });

        if ($workbook !== false) {
            throw new Exception('This workbook is already existed. Please chose another name');
        }

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return $item->name == $name;
        });
        if ($workbook === false) {
            throw new Exception('Workbook not found');
        } else {
            $this->workbooks[$workbook]->name = $new_name;
        }
        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function changeOrder($src_name, $dest_name)
    {
        if (!isset($this->workbooks)) {
            throw new Exception('No workbook found');
        }

        $src_workbook = unl_array_find_key($this->workbooks, function ($item) use ($src_name) {
            return $item->name == $src_name;
        });
        if ($src_workbook === false) {
            throw new Exception('Workbook not found');
        } else {
            $src_workbook = $this->workbooks[$src_workbook];
        }

        $dest_workbook = unl_array_find_key($this->workbooks, function ($item) use ($dest_name) {
            return $item->name == $dest_name;
        });
        if ($dest_workbook === false) {
            throw new Exception('Workbook not found');
        } else {
            $dest_workbook = $this->workbooks[$dest_workbook];
        }

        $src_weight = $src_workbook->weight;
        $dest_weight = $dest_workbook->weight;

        $affects = [];
        if ($src_weight <= $dest_weight) {
            foreach ($this->workbooks as $item) {
                if ($item->weight >= $src_weight && $item->weight <= $dest_weight) $affects[] = $item;
            }
        } else {
            foreach ($this->workbooks as $item) {
                if ($item->weight <= $src_weight && $item->weight >= $dest_weight) $affects[] = $item;
            }
        }

        objSort($affects, function ($item) {
            return $item->weight;
        });

        if ($src_weight > $dest_weight) {
            foreach ($affects as $key => $item) {
                if (isset($affects[$key + 1])) {
                    $item->weight = $affects[$key + 1]->weight;
                }
            }
        } else {
            for ($key = count($affects) - 1; $key >= 0; $key--) {
                if (isset($affects[$key - 1])) {
                    $affects[$key]->weight = $affects[$key - 1]->weight;
                }
            }
        }
        $src_workbook->weight = $dest_weight;

        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    public function updateContent($name, $content, $menu = [])
    {
        if (!isset($this->workbooks)) throw new Exception('No workbook found');

        $workbook = unl_array_find_key($this->workbooks, function ($item) use ($name) {
            return $item->name == $name;
        });
        if ($workbook === false) throw new Exception('Workbook not found');
        $workbook = $this->workbooks[$workbook];

        if ((filesize($this->file) + strlen(json_encode($content))) > (100 * 1024 * 1024)) throw new Exception('
                        Lab size must be less than 50M. The large Workbook size will reduce the Lab speed
                    ');

        if ($workbook->type == 'html') {
            $workbook->menu = $menu;
            $workbook->content = $content;
        } else {
            $workbook->content = $content;
        }

        $result = $this->save();
        if ($result != 0) {
            throw new Exception($GLOBALS['messages'][$result]);
        }
    }

    /* lineobjects*/

    private $lineobjects = array();
    public function getLineObjects()
    {
        return $this->lineobjects;
    }
    public function setLineObjects($lineobjects)
    {
        $this->lineobjects = $lineobjects;
        return $this->save();
    }

    public function setBackground($darkmode = 1, $mode3d = 0, $nogrid = 1)
    {
        $this->darkmode = $darkmode;
        $this->mode3d = $mode3d;
        $this->nogrid = $nogrid;
        return $this->save();
    }

    public function getDarkMode()
    {
        return $this->darkmode;
    }

    public function get3dMode()
    {
        return $this->mode3d;
    }

    public function getNoGrid()
    {
        return $this->nogrid;
    }


    //===================PNETLAB============================
}





class indentify
{

    private static $user;

    public function getUser($pod)
    {
        if (self::$user === null) {
            $query = 'SELECT * FROM users WHERE pod = :pod';
            $db = checkDatabase();
            $statement = $db->prepare($query);
            $statement->execute(['pod' => $pod]);
            $user = $statement->fetchAll(PDO::FETCH_ASSOC);
            if (!isset($user[0])) return null;
            self::$user = $user[0];
        }
        return self::$user;
    }

    private function crypt_data($string, $action = 'e')
    {
        // you may change these values to your own
        try {

            $secret_key = "gsgsgsghkjjghksgs%^465#";
            $secret_iv = "etwdgsio##kljhjgf%^465#";

            $output = false;
            $encrypt_method = "AES-256-CBC";
            $key = hash('sha256', $secret_key);
            $iv = substr(hash('sha256', $secret_iv), 0, 16);
            if ($action == 'e') {
                $output = base64_encode(openssl_encrypt(time() . '##time##' . $string, $encrypt_method, $key, 0, $iv));
            } else if ($action == 'd') {
                $output = openssl_decrypt(base64_decode($string), $encrypt_method, $key, 0, $iv);

                $outputArray = explode('##time##', $output);
                $output = [];
                $output['payload'] = $outputArray[1];
                $output['iat'] = $outputArray[0];
            }
            return $output;
        } catch (\Exception $e) {
            return false;
        }
    }


    private function get_uuid()
    {
        return broker_exec('system_uuid', []);
    }

    public function getKey()
    {
        return $this->crypt_data($this->get_uuid());
    }

    
    public function isOffline($pod)
    {
        $user = $this->getUser($pod);
        return $user[USER_OFFLINE] == '1';
    }

    public function authorization($cookie)
    {

        $output = array();
        $db = checkDatabase();
        $user = $this->getUserByCookie($db, $cookie);    // This will check session/web/pod expiration too

        if (empty($user)) {
            // Used not logged in
            $output['code'] = 412;
            $output['status'] = 'unauthorized';
            $output['message'] = $GLOBALS['messages']['90001'];
            return array(False, False, $output);
        } else {
            // User logged in
            $rc = updateUserCookie($db, $user['username'], $cookie);

            if ($rc !== 0) {
                // Cannot update user cookie
                $output['code'] = 500;
                $output['status'] = 'error';
                $output['message'] = $GLOBALS['messages'][$rc];
                return array(False, False, $output);
            }
        }

        return array($user, $user['pod'], False);
    }


    private function getUserByCookie($db, $cookie)
    {
        $GLOBALS['user'] = null;
        $now = time();
        try {
            $query = 'SELECT * FROM users WHERE cookie = :cookie AND users.session >= :session';

            $statement = $db->prepare($query);
            $statement->bindParam(':cookie', $cookie, PDO::PARAM_STR);
            $statement->bindParam(':session', $now, PDO::PARAM_INT);

            $statement->execute();
            $result = $statement->fetchAll(PDO::FETCH_ASSOC);

            if (!isset($result[0])) return [];
            $result = $result[0];

            // Containment: status / activation date / expiry date / allowed
            // weekdays (access_days = PHP date('N') digits, 1=Mon..7=Sun, e.g.
            // "12345" = Mon-Fri; blank/NULL = any day).
            //
            // These used to sit behind "if ($result[USER_ROLE] != 0)", i.e.
            // admins were exempt and a disabled admin account was never actually
            // disabled. The exemption is gone: admins are subject to the same
            // checks. A NULL/absent/0 field never denies, and the shipped admin
            // account (user_status=1, NULL windows) passes all four. Enforced on
            // EVERY authenticated request, so revoking an account also kills any
            // token it already holds. Same helper as the /api/auth login path.
            $violation = userContainmentViolation($result);
            if ($violation !== null) {
                list($reason, $detail) = $violation;
                if ($reason === 'unactive') throw new ResponseException('error_user_unactive', ['data' => $detail]);
                if ($reason === 'expired') throw new ResponseException('error_user_expired', ['data' => $detail]);
                if ($reason === 'days') throw new ResponseException('Lab access is not allowed today — your account is limited to scheduled days', ['data' => $detail]);
                throw new Exception('You do not have access');
            }

            self::$user = array(
                'email' => $result['email'],
                'folder' => $result['folder'],
                'lab' => $result['lab_session'],
                'name' => $result['name'],
                'role' => $result['role'],
                'pod' => $result['pod'],
                'html5' => $result['html5'],
                'username' => $result['username'],
                USER_PASSWORD => $result[USER_PASSWORD],
                USER_OFFLINE => $result[USER_OFFLINE],
                USER_WORKSPACE => $result[USER_WORKSPACE],
                USER_MAX_NODE => $result[USER_MAX_NODE],
                USER_MAX_NODELAB => $result[USER_MAX_NODELAB],
                USER_MAX_CPU => $result[USER_MAX_CPU],
                USER_MAX_RAM => $result[USER_MAX_RAM],
               
            );

            $GLOBALS['user'] = self::$user;
            return $GLOBALS['user'];
        } catch (Exception $e) {
            error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][90026]);
            error_log(date('M d H:i:s ') . (string) $e);
            return array();;
        }
    }

}
