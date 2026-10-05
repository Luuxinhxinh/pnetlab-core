"""Structured plans are validated before approval and again before execution."""
import json
import copy

READ_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "result_id": {"type": "string"}, "path": {"type": "string"},
        "offset": {"type": "integer", "minimum": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
        "fields": {"type": "array", "items": {"type": "string"}, "maxItems": 20}},
    "required": ["result_id"]}


def inline_schema(schema):
    """Inline local definitions for compatibility with provider tool schemas."""
    definitions = schema.get("$defs", schema.get("definitions", {}))
    def visit(value):
        if isinstance(value, list):
            return [visit(v) for v in value]
        if isinstance(value, dict):
            if "$ref" in value:
                name = value["$ref"].split("/")[-1]
                if name not in definitions:
                    raise ValueError("unsupported schema reference")
                return visit(definitions[name])
            return {k: visit(v) for k, v in value.items() if k not in ("$defs", "definitions")}
        return value
    return visit(schema)


def plan_schema(actions, schemas=None):
    return {"type": "object", "additionalProperties": False,
            "properties": {
                "summary": {"type": "string", "minLength": 1, "maxLength": 8000},
                "actions": {"type": "array", "minItems": 1, "maxItems": 100,
                            "items": {"type": "object", "additionalProperties": False,
                                      "properties": {"tool": {"enum": sorted(actions)},
                                                     "args": {"type": "object"}},
                                      "required": ["tool", "args"]}}},
            "required": ["summary", "actions"]}


def executable_plan_schema(actions, schemas):
    schema = plan_schema(actions)
    schema["properties"]["actions"]["items"] = {"oneOf": [
        {"type": "object", "additionalProperties": False,
         "properties": {"tool": {"const": name}, "args": plan_args_schema(schemas[name])},
         "required": ["tool", "args"]} for name in sorted(actions)]}
    return schema


def plan_args_schema(schema):
    schema = copy.deepcopy(inline_schema(schema))
    for key, kind in (("id", "node"), ("node_id", "node"), ("a_id", "node"),
                      ("b_id", "node"), ("net_id", "network")):
        props = schema.get("properties", {})
        if key in props:
            ref = "$" + kind
            props[key] = {"anyOf": [props[key], {"type": "object", "additionalProperties": False,
                "properties": {ref: {"type": "string", "minLength": 1}}, "required": [ref]}]}
    return schema


def validate_plan(plan, schemas, allowed, lab_path):
    from jsonschema import Draft202012Validator
    Draft202012Validator(plan_schema(allowed)).validate(plan)
    if len(json.dumps(plan)) > 200_000:
        raise ValueError("plan is too large; split the build")
    for action in plan["actions"]:
        tool, args = action["tool"], action["args"]
        if tool not in schemas:
            raise ValueError("unavailable plan tool: " + tool)
        Draft202012Validator(plan_args_schema(schemas[tool])).validate(args)
        # A saved plan stays bound to the lab where it was approved. New labs
        # are allowed through create_lab, after which omitted paths use that lab.
        if args.get("lab_path") and args["lab_path"] != lab_path:
            raise ValueError("plan cannot switch to a different existing lab")
    return plan
