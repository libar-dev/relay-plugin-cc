// Run only against a local `codex app-server generate-json-schema --out DIR` bundle.
import fs from "node:fs";
import assert from "node:assert/strict";

const [directory, codexVersion] = process.argv.slice(2);
assert.ok(directory && codexVersion, 'Usage: node extract.mjs SCHEMA_DIR "codex-cli VERSION"');
const read = file => JSON.parse(fs.readFileSync(`${directory}/${file}`, "utf8"));
// Drop annotations, retain every validation keyword and every referenced definition.
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["description", "title", "default", "$schema"].includes(key))
    .map(([key, value]) => [key, ["properties", "definitions"].includes(key)
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, strip(schema)]))
      : strip(value)]));
}
const definitions = {};
function checkKeywords(schema) {
  if (typeof schema === "boolean") return;
  const supported = ["$ref", "type", "enum", "required", "properties", "additionalProperties",
    "items", "oneOf", "anyOf", "allOf", "minimum", "minLength", "format", "definitions"];
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(supported.includes(key), `Extend the contract validator for schema keyword: ${key}`);
    if (["properties", "definitions"].includes(key)) Object.values(value).forEach(checkKeywords);
    else if (["oneOf", "anyOf", "allOf"].includes(key)) value.forEach(checkKeywords);
    else if (["items", "additionalProperties"].includes(key)) checkKeywords(value);
  }
}
function extract(schema, root = schema) {
  const node = strip(root);
  checkKeywords(node);
  function refs(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/definitions/"));
      const name = value.$ref.slice("#/definitions/".length);
      const definition = strip(schema.definitions[name]);
      assert.ok(definition, name);
      checkKeywords(definition);
      if (definitions[name]) assert.deepEqual(definitions[name], definition, name);
      else { definitions[name] = definition; refs(definition); }
    }
    for (const child of Object.values(value)) refs(child);
  }
  refs(node);
  delete node.definitions;
  return node;
}
const client = read("ClientRequest.json");
const server = read("ServerNotification.json");
const schemas = {
  ThreadReadRequest: extract(client, client.oneOf.find(s => s.properties.method.enum.includes("thread/read"))),
  ThreadReadResponse: extract(read("v2/ThreadReadResponse.json")),
  JSONRPCResponse: extract(read("JSONRPCResponse.json")),
  JSONRPCError: extract(read("JSONRPCError.json"))
};
for (const method of ["thread/started", "thread/name/updated", "turn/started", "turn/completed", "item/started", "item/completed", "error"]) {
  schemas[method] = extract(server, server.oneOf.find(s => s.properties.method.enum.includes(method)));
}
fs.writeFileSync(new URL("contract.json", import.meta.url), JSON.stringify({
  codexVersion,
  generationCommand: "codex app-server generate-json-schema --out SCHEMA_DIR",
  $schema: "http://json-schema.org/draft-07/schema#",
  schemas,
  definitions
}, null, 2) + "\n");
