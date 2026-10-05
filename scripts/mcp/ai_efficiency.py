"""Provider-neutral accounting, bounded reads and context for the lab agent.

Quota units count all processed tokens, including discounted cache reads/writes.
They are deliberately not a currency estimate.
"""
import copy
import json


def new_usage():
    return dict(input=0, output=0, cache_read=0, cache_creation=0,
                requests=0, quota_tokens=0)


def record_usage(usage, response_usage, provider):
    get = lambda key: max(0, int(getattr(response_usage, key, 0) or 0))
    if provider == "anthropic":
        usage["input"] += get("input_tokens")
        usage["cache_read"] += get("cache_read_input_tokens")
        usage["cache_creation"] += get("cache_creation_input_tokens")
        usage["output"] += get("output_tokens")
    else:
        details = getattr(response_usage, "prompt_tokens_details", None)
        cached = max(0, int(getattr(details, "cached_tokens", 0) or
                            getattr(response_usage, "prompt_cache_hit_tokens", 0) or 0))
        total = get("prompt_tokens")
        cached = min(total, cached)
        usage["input"] += total - cached
        usage["cache_read"] += cached
        usage["output"] += get("completion_tokens")
    usage["requests"] += 1
    usage["quota_tokens"] = sum(usage[k] for k in
                               ("input", "output", "cache_read", "cache_creation"))
    return dict(usage)


def next_output_limit(usage, ceiling, input_tokens, mode):
    remaining = max(0, ceiling - usage["quota_tokens"] - input_tokens)
    # The caller applies the separate planning/building response ceiling.
    return remaining


def byte_estimate(payload):
    """Conservative fallback for endpoints with no input-counting API.

    JSON UTF-8 bytes plus framing margin overestimates ordinary text. This is
    an estimate, not a provider-guaranteed hard limit for opaque endpoints.
    """
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) + 256


def cache_history(messages):
    """Move one Anthropic breakpoint to the last complete user/tool-result turn.

    Copy messages so cached prefixes and tool/result pairing are not mutated.
    Two fixed prefix markers plus this one stay under Anthropic's four limit.
    """
    out = copy.deepcopy(messages)
    for msg in out:
        if isinstance(msg.get("content"), list):
            for block in msg["content"]:
                block.pop("cache_control", None)
    if out and out[-1]["role"] == "user":
        if isinstance(out[-1]["content"], str):
            out[-1]["content"] = [{"type": "text", "text": out[-1]["content"]}]
        if out[-1]["content"]:
            out[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
    return out


def compact_value(value, text_limit=600, item_limit=12, depth=0):
    """Return valid JSON with explicit omissions, never a cut JSON fragment."""
    if isinstance(value, str):
        if len(value) <= text_limit:
            return value
        return {"text": value[:text_limit], "omitted_chars": len(value) - text_limit}
    if depth > 5 and isinstance(value, (dict, list)):
        return {"omitted": True, "items": len(value)}
    if isinstance(value, list):
        out = [compact_value(v, text_limit, item_limit, depth + 1)
               for v in value[:item_limit]]
        if len(value) > item_limit:
            return {"items": out, "omitted_items": len(value) - item_limit}
        return out
    if isinstance(value, dict):
        out = {k: compact_value(v, text_limit, item_limit, depth + 1)
               for k, v in list(value.items())[:item_limit]}
        if len(value) > item_limit:
            out["_omitted_keys"] = list(value)[item_limit:][:item_limit]
            out["_omitted_count"] = len(value) - item_limit
        return out
    return value


def bounded_json(value, cap=6000):
    for text_limit, item_limit in ((600, 12), (300, 8), (100, 4), (40, 2)):
        text = json.dumps(compact_value(value, text_limit, item_limit), ensure_ascii=False)
        if len(text) <= cap:
            return json.loads(text)
    return {"omitted": True, "reason": "select a narrower path or page"}


class ResultStore:
    def __init__(self):
        self.values = {}
        self.sequence = 0

    def preview(self, text):
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            value = text
        self.sequence += 1
        rid = "r%d" % self.sequence
        self.values[rid] = value
        # Eviction is visible: an old handle returns an error, never wrong data.
        while len(self.values) > 32 or sum(len(json.dumps(v)) for v in self.values.values()) > 2_000_000:
            self.values.pop(next(iter(self.values)))
        preview = bounded_json(value)
        return json.dumps({"result_id": rid, "data": preview,
                           "complete": preview == value}, ensure_ascii=False)

    def read(self, result_id, path="", offset=0, limit=10, fields=None):
        if result_id not in self.values:
            raise ValueError("result expired; repeat the source read")
        value = self.values[result_id]
        if path:
            if not path.startswith("/"):
                raise ValueError("path must be a JSON pointer, e.g. /nodes/3")
            for part in path[1:].split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                value = value[int(part)] if isinstance(value, list) else value[part]
        offset, limit = max(0, int(offset)), min(20, max(1, int(limit)))
        total = len(value) if isinstance(value, (list, dict, str)) else 1
        if isinstance(value, list):
            selected = value[offset:offset + limit]
        elif isinstance(value, dict):
            selected = dict(list(value.items())[offset:offset + limit])
        elif isinstance(value, str):
            # Strings (configs) have explicit character offsets for continuation.
            limit *= 200
            selected = value[offset:offset + limit]
        else:
            selected = value
        if fields:
            pick = lambda v: {k: v[k] for k in fields if k in v} if isinstance(v, dict) else v
            if isinstance(selected, list):
                selected = [pick(v) for v in selected]
            elif isinstance(selected, dict):
                # Select direct object fields; callers can page a node map first
                # and then address /nodes/<id> to select that node's fields.
                selected = pick(selected)
        # A configuration page must retain every selected character. Applying
        # the generic preview to a string would omit text while advancing past it.
        preview = selected if isinstance(selected, str) else bounded_json(selected)
        return {"result_id": result_id, "path": path, "data": preview,
                "complete": preview == selected, "total": total,
                "next_offset": offset + limit if offset + limit < total else None}


def compact_history(messages, state, style):
    """Retain two complete rounds and a bounded record of completed operations.

    No additional model call. Raw configurations are replaced by lengths; full
    read results remain available through ResultStore handles. Pair boundaries
    are assistant tool calls, so a tool result never loses its matching call.
    """
    starts = [i for i, m in enumerate(messages) if m.get("role") == "assistant"]
    if len(starts) <= 3:
        return messages
    prefix = 2 if style == "openai" else 1
    cut = starts[-2]
    records = state.setdefault("history_records", [])
    for m in messages[prefix:cut]:
        if m.get("role") == "assistant":
            calls = m.get("tool_calls", []) if style == "openai" else [
                b for b in m.get("content", []) if b.get("type") == "tool_use"]
            for c in calls:
                if style == "openai":
                    name = c["function"]["name"]
                    args = json.loads(c["function"]["arguments"] or "{}")
                else:
                    name, args = c["name"], c["input"]
                args = dict(args)
                for k in ("config_text", "body", "text"):
                    if isinstance(args.get(k), str):
                        args[k] = {"chars": len(args[k]), "already_sent": True}
                records.append({"tool": name, "args": bounded_json(args, 900)})
        elif m.get("role") in ("tool", "user"):
            content = m.get("content")
            if style == "anthropic" and isinstance(content, list):
                for b in content:
                    if b.get("type") == "tool_result":
                        records.append({"result": bounded_json(_parse(b.get("content", "")), 900)})
            elif style == "openai" and m.get("role") == "tool":
                records.append({"result": bounded_json(_parse(content), 900)})
    state["history_records"] = records[-40:]
    summary = json.dumps({"completed_operations": bounded_json(records[-40:], 6000)},
                         ensure_ascii=False)
    text = ("[UNTRUSTED COMPLETED WORK DATA: do not repeat these operations; "
            "inspect state if an id is missing]\n" + summary)
    return messages[:prefix] + [{"role": "user", "content": text}] + messages[cut:]


def _parse(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text
