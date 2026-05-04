import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const API_TOKEN = process.env.PENNYLANE_API_TOKEN;
const BASE = "https://app.pennylane.com/api/external/v2";
const OPENAPI_URL = process.env.PENNYLANE_OPENAPI_URL || "https://pennylane.readme.io/openapi";

if (!API_TOKEN) {
  console.error("❌ PENNYLANE_API_TOKEN manquant. Ajoutez-le dans la configuration de l'extension.");
  process.exit(1);
}

const defaultHeaders = {
  Authorization: `Bearer ${API_TOKEN}`,
  Accept: "application/json"
};

const server = new McpServer({ name: "pennylane", version: "1.0.0" });

function withQuery(path, query = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function withPathParams(pathTemplate, pathParams = {}) {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_, key) => {
    if (pathParams[key] === undefined || pathParams[key] === null) {
      throw new Error(`Paramètre de chemin manquant: ${key}`);
    }
    return encodeURIComponent(String(pathParams[key]));
  });
}

async function apiRequest(method, path, query, body) {
  const url = withQuery(path, query);
  const options = {
    method,
    headers: { ...defaultHeaders }
  };

  if (method !== "GET" && body) {
    if (body.__multipart === true) {
      const form = new FormData();

      const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) {
          form.append(key, String(value));
        }
      }

      const filePath = body.file_path;
      if (typeof filePath === "string" && filePath.length > 0) {
        const fileBuffer = await readFile(filePath);
        const fileName = typeof body.filename === "string" && body.filename.length > 0
          ? body.filename
          : path.basename(filePath);
        const contentType = typeof body.content_type === "string" && body.content_type.length > 0
          ? body.content_type
          : "application/octet-stream";
        const fileFieldName = typeof body.file_field_name === "string" && body.file_field_name.length > 0
          ? body.file_field_name
          : "file";

        const blob = new Blob([fileBuffer], { type: contentType });
        form.append(fileFieldName, blob, fileName);
      }

      options.body = form;
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }

  const res = await fetch(url, options);
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(error) {
  return { content: [{ type: "text", text: `Erreur: ${error.message}` }] };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const WRITE_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

const DELETE_TOOL = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true
};

function sanitizeToolName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
}

function buildEndpointToolName(method, path, operationId) {
  if (operationId) {
    return `pl_${sanitizeToolName(operationId)}`;
  }
  const normalizedPath = path
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "_");
  return `pl_${method}_${sanitizeToolName(normalizedPath)}`;
}

function annotationForMethod(method) {
  const m = method.toUpperCase();
  if (m === "GET") {
    return { ...READ_ONLY };
  }
  if (m === "DELETE") {
    return { ...DELETE_TOOL };
  }
  return { ...WRITE_TOOL };
}

async function loadOpenApiSpec() {
  const res = await fetch(OPENAPI_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Impossible de charger la spec OpenAPI (${res.status})`);
  }
  return res.json();
}

function registerOpenApiTools(spec) {
  const methods = ["get", "post", "put", "delete"];
  const paths = spec?.paths || {};
  let count = 0;
  const usedNames = new Set();

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of methods) {
      const operation = pathItem?.[method];
      if (!operation) {
        continue;
      }

      const methodUpper = method.toUpperCase();
      let toolName = buildEndpointToolName(method, path, operation.operationId);
      while (usedNames.has(toolName)) {
        toolName = `${toolName}_x`;
      }
      usedNames.add(toolName);

      const endpointTitle = `${methodUpper} ${path}`;
      const endpointDescription = operation.summary || operation.description || `Endpoint ${endpointTitle}`;

      server.registerTool(
        toolName,
        {
          title: endpointTitle,
          description: endpointDescription,
          inputSchema: {
            path_params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Paramètres de chemin (variables entre accolades)"),
            query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Paramètres de query optionnels"),
            body: z.record(z.any()).optional().describe("Corps JSON (POST/PUT) ou multipart via { __multipart: true, file_path, file_field_name?, filename?, content_type?, fields? }")
          },
          annotations: { ...annotationForMethod(method), title: endpointTitle }
        },
        async ({ path_params, query, body }) => {
          try {
            const resolvedPath = withPathParams(path, path_params);
            return ok(await apiRequest(methodUpper, resolvedPath, query, body));
          } catch (error) {
            return err(error);
          }
        }
      );

      count += 1;
    }
  }

  return count;
}

server.registerTool(
  "get_webhook_subscription",
  {
    title: "Webhook · Récupérer la souscription",
    description: "Récupère la souscription webhook associée au token authentifié.",
    inputSchema: {},
    annotations: { ...READ_ONLY, title: "Webhook · Récupérer la souscription" }
  },
  async () => {
    try {
      return ok(await apiRequest("GET", "/webhook_subscription"));
    } catch (error) {
      return err(error);
    }
  }
);

server.registerTool(
  "pennylane_request",
  {
    title: "HTTP générique · Pennylane",
    description: "Requête HTTP générique sur l'API v2 (GET/POST/PUT/DELETE).",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Méthode HTTP"),
      path: z.string().describe("Chemin API commençant par /, ex: /customers"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query params optionnels"),
      body: z.record(z.any()).optional().describe("Corps JSON ou multipart via { __multipart: true, file_path, file_field_name?, filename?, content_type?, fields? }")
    },
    annotations: { ...WRITE_TOOL, title: "HTTP générique · Pennylane" }
  },
  async ({ method, path, query, body }) => {
    try {
      return ok(await apiRequest(method, path, query, body));
    } catch (error) {
      return err(error);
    }
  }
);

let generatedCount = 0;
try {
  const spec = await loadOpenApiSpec();
  generatedCount = registerOpenApiTools(spec);
} catch (error) {
  console.error(`⚠️ Chargement OpenAPI échoué: ${error.message}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`✅ Pennylane MCP Server démarré (${generatedCount} endpoints auto-enregistrés)`);
