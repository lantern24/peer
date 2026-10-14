// Deterministic protocol fixture, deliberately not a semantic resolver.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
let buffer = Buffer.alloc(0),
  root;
const documents = new Map();
const failures = new Map();
const errorFixture = JSON.parse(process.env.PEER_FAKE_ERRORS ?? "null");
const send = (value) => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }));
  // Exercise framing with headers and bodies delivered separately.
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
  process.stdout.write(bytes);
};
const walk = (directory, extension) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const name = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(name, extension)
      : path.extname(name) === extension
        ? [name]
        : [];
  });
function receive(message) {
  const { id, method, params } = message;
  if (id === "config" && !method) {
    if (
      process.env.PEER_FAKE_EXPECT_CONFIG &&
      JSON.stringify(message.result) !== process.env.PEER_FAKE_EXPECT_CONFIG
    )
      process.exit(3);
  } else if (method === "$/cancelRequest") {
    // Deliberately violate cancellation by returning a late response. The
    // client must discard it rather than delivering it to the next request.
    send({
      id: params.id,
      result: [
        {
          uri: "file:///obsolete.ts",
          range: {
            start: { line: 99, character: 0 },
            end: { line: 99, character: 1 },
          },
        },
      ],
    });
  } else if (method === "initialize") {
    root = fileURLToPath(params.rootUri);
    if (process.env.PEER_FAKE_LOG)
      fs.appendFileSync(process.env.PEER_FAKE_LOG, `${root}\n`);
    send({
      id,
      result: {
        capabilities: {
          definitionProvider: process.env.PEER_FAKE_UNSUPPORTED !== "1",
          referencesProvider: true,
          textDocumentSync: 1,
        },
      },
    });
  } else if (method === "initialized") {
    send({
      id: "config",
      method: "workspace/configuration",
      params: { items: [{ section: "fixture" }] },
    });
  } else if (method === "textDocument/didOpen")
    documents.set(params.textDocument.uri, params.textDocument.text);
  else if (method === "shutdown") send({ id, result: null });
  else if (method === "exit") process.exit(0);
  else if (
    method === "textDocument/definition" ||
    method === "textDocument/references"
  ) {
    if (errorFixture) {
      const key = `${method}:${params.textDocument.uri}`;
      const count = failures.get(key) ?? 0;
      if (count < errorFixture.count) {
        failures.set(key, count + 1);
        send({
          id,
          error: { code: errorFixture.code, message: "content modified" },
        });
        return;
      }
    }
    const text =
      documents.get(params.textDocument.uri) ??
      fs.readFileSync(fileURLToPath(params.textDocument.uri), "utf8");
    const line = text.split("\n")[params.position.line] ?? "";
    const word = [...line.matchAll(/[\p{L}\p{N}_$]+/gu)].find(
      (match) =>
        match.index <= params.position.character &&
        match.index + match[0].length > params.position.character,
    )?.[0];
    if (word === "hang") return;
    if (word === "crash") return process.exit(2);
    const range = (line, character, length) => ({
      start: { line, character },
      end: { line, character: character + length },
    });
    if (word === "external" && process.env.PEER_FAKE_EXTERNAL) {
      send({
        id,
        result: {
          uri: pathToFileURL(process.env.PEER_FAKE_EXTERNAL).href,
          range: range(0, 0, 8),
        },
      });
      return;
    }
    const results = [];
    if (word)
      for (const name of walk(
        root,
        path.extname(fileURLToPath(params.textDocument.uri)),
      )) {
        const lines = fs.readFileSync(name, "utf8").split("\n");
        lines.forEach((line, index) => {
          for (const occurrence of line.matchAll(
            new RegExp(`\\b${word}\\b`, "g"),
          )) {
            const declaration =
              /(?:const|let|var|function|func|def|fn)\s+$/.test(
                line.slice(0, occurrence.index),
              );
            if (method.endsWith("/definition") ? declaration : !declaration)
              results.push({
                uri: pathToFileURL(name).href,
                range: range(index, occurrence.index, word.length),
              });
          }
        });
      }
    let result = results;
    if (
      method.endsWith("/definition") &&
      process.env.PEER_FAKE_FORM === "links"
    )
      result = results.map((location) => ({
        targetUri: location.uri,
        targetSelectionRange: location.range,
        targetRange: {
          start: { line: 0, character: 0 },
          end: { line: 100, character: 0 },
        },
      }));
    if (
      method.endsWith("/definition") &&
      process.env.PEER_FAKE_FORM === "single"
    )
      result = results[0] ?? null;
    send({ id, result });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1],
    );
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    receive(message);
  }
});
