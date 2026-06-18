import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://app.pennylane.com/api/external/v2";
const MAX_COMPANIES = 7;

function loadCompaniesFromEnv() {
  const list = [];
  const seenNames = new Set();

  const legacyToken = process.env.PENNYLANE_API_TOKEN;
  if (typeof legacyToken === "string" && legacyToken.trim().length > 0) {
    const legacyName = (process.env.PENNYLANE_COMPANY_NAME || "Société 1").trim() || "Société 1";
    list.push({ slot: 1, name: legacyName, token: legacyToken.trim() });
    seenNames.add(legacyName.toLowerCase());
  }

  for (let i = 1; i <= MAX_COMPANIES; i++) {
    const token = process.env[`PENNYLANE_API_TOKEN_${i}`];
    if (typeof token !== "string" || token.trim().length === 0) continue;

    const rawName = process.env[`PENNYLANE_COMPANY_NAME_${i}`];
    let name = (typeof rawName === "string" && rawName.trim().length > 0)
      ? rawName.trim()
      : `Société ${i}`;

    let suffix = 1;
    let candidate = name;
    while (seenNames.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${name} (${suffix})`;
    }
    name = candidate;
    seenNames.add(name.toLowerCase());

    const existingSlot = list.find((c) => c.slot === i);
    if (existingSlot) {
      existingSlot.name = name;
      existingSlot.token = token.trim();
    } else {
      list.push({ slot: i, name, token: token.trim() });
    }
  }

  return list;
}

const companies = loadCompaniesFromEnv();

if (companies.length === 0) {
  console.error("❌ Aucun token Pennylane configuré. Renseignez au moins PENNYLANE_API_TOKEN_1 (et idéalement PENNYLANE_COMPANY_NAME_1) dans la configuration de l'extension.");
  process.exit(1);
}

let activeCompany = companies[0];

function findCompanyByName(name) {
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const needle = name.trim().toLowerCase();
  return companies.find((c) => c.name.toLowerCase() === needle) || null;
}

function buildAuthHeaders(company) {
  return {
    Authorization: `Bearer ${company.token}`,
    Accept: "application/json"
  };
}

const server = new McpServer({ name: "pennylane", version: "1.0.8" });

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

async function apiRequest(method, path, query, body, companyOverride) {
  let company = activeCompany;
  if (companyOverride) {
    const found = findCompanyByName(companyOverride);
    if (!found) {
      const available = companies.map((c) => c.name).join(", ");
      throw new Error(`Société inconnue: "${companyOverride}". Sociétés disponibles: ${available}`);
    }
    company = found;
  }

  const url = withQuery(path, query);
  const options = {
    method,
    headers: buildAuthHeaders(company)
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

function pathSegments(path) {
  return path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("{"));
}

function categoryFromPath(path) {
  const segments = pathSegments(path);
  const has = (prefix) => segments.some((segment) => segment.startsWith(prefix));

  if (has("webhook")) return "Webhook";
  if (has("journal") || has("ledger") || has("trial_balance") || has("fiscal_year")) return "Comptabilité";
  if (has("customer_invoice") || has("supplier_invoice") || has("commercial_document")) return "Facturation";
  if (has("quote")) return "Devis";
  if (has("billing_subscription")) return "Abonnements";
  if (has("category") || has("categories")) return "Catégories";
  if (has("changelog")) return "Changelog";
  if (has("mandate") || has("sepa") || has("gocardless")) return "Mandats";
  if (has("transaction") || has("bank_")) return "Banque";
  if (has("product")) return "Produits";
  if (has("customer") || has("supplier")) return "Tiers";
  if (has("export")) return "Exports";
  if (has("purchase_request")) return "Achats";
  if (has("pa_registration")) return "Conformité";
  return "API";
}

function resourceFromPath(path) {
  const cleaned = pathSegments(path);
  const leaf = cleaned[cleaned.length - 1] || "resource";

  const resourceLabels = [
    ["customer_invoices", "factures clients"],
    ["supplier_invoices", "factures fournisseurs"],
    ["commercial_documents", "documents commerciaux"],
    ["billing_subscriptions", "abonnements"],
    ["category_groups", "groupes de categories"],
    ["categories", "categories"],
    ["ledger_entry_lines", "lignes d'ecriture"],
    ["ledger_entries", "ecritures comptables"],
    ["ledger_accounts", "comptes comptables"],
    ["journals", "journaux"],
    ["quotes", "devis"],
    ["transactions", "transactions"],
    ["bank_accounts", "comptes bancaires"],
    ["bank_establishments", "etablissements bancaires"],
    ["customers", "clients"],
    ["company_customers", "clients entreprise"],
    ["individual_customers", "clients individuels"],
    ["suppliers", "fournisseurs"],
    ["purchase_requests", "demandes d'achat"],
    ["products", "produits"],
    ["webhook_subscription", "souscription webhook"],
    ["trial_balance", "balance generale"],
    ["fiscal_years", "exercices fiscaux"],
    ["pa_registrations", "inscriptions PA"],
    ["sepa_mandates", "mandats SEPA"],
    ["gocardless_mandates", "mandats GoCardless"],
    ["file_attachments", "pieces jointes"],
    ["ledger_attachments", "pieces comptables"],
    ["exports", "exports"],
    ["changelogs", "changelogs"]
  ];

  for (const [key, label] of resourceLabels) {
    if (path.includes(`/${key}`) || leaf === key) {
      return label;
    }
  }

  return leaf.replace(/_/g, " ");
}

function actionFromMethod(method, hasPathParams) {
  const m = method.toUpperCase();
  if (m === "GET") return hasPathParams ? "Recuperer" : "Lister";
  if (m === "POST") return "Creer";
  if (m === "PUT") return "Mettre à jour";
  if (m === "DELETE") return "Supprimer";
  return m;
}

function isRawEndpointLabel(value) {
  return typeof value === "string" && /^(GET|POST|PUT|DELETE)\s+\//.test(value.trim());
}

function buildFriendlyToolMeta(method, path, providedTitle, providedDescription) {
  if (
    typeof providedTitle === "string" &&
    providedTitle.trim().length > 0 &&
    !isRawEndpointLabel(providedTitle)
  ) {
    return { title: providedTitle, description: providedDescription };
  }

  const category = categoryFromPath(path);
  const resource = resourceFromPath(path);
  const hasPathParams = /\{[^}]+\}/.test(path);
  const action = actionFromMethod(method, hasPathParams);
  const title = `${category} · ${action} ${resource}`;
  const description = `${action} ${resource} via ${method.toUpperCase()} ${path}.`;
  return { title, description };
}

function registerStaticEndpointTool({
  name,
  title,
  description,
  method,
  path,
  hasPathParams = false,
  hasQuery = true,
  hasBody = false
}) {
  const inputSchema = {};
  if (hasPathParams) {
    inputSchema.path_params = z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .describe("Paramètres de chemin (ex: id, supplier_invoice_id, category_group_id)");
  }
  if (hasQuery) {
    inputSchema.query = z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Paramètres de query");
  }
  if (hasBody) {
    inputSchema.body = z
      .record(z.any())
      .optional()
      .describe("Corps JSON ou multipart via { __multipart: true, file_path, file_field_name?, filename?, content_type?, fields? }");
  }
  inputSchema.company_name = z
    .string()
    .optional()
    .describe("Nom de la société à utiliser pour cette requête (sinon, société active courante).");

  const friendlyMeta = buildFriendlyToolMeta(method, path, title, description);

  server.registerTool(
    name,
    {
      title: friendlyMeta.title,
      description: friendlyMeta.description,
      inputSchema,
      annotations: { ...annotationForMethod(method), title: friendlyMeta.title }
    },
    async ({ path_params, query, body, company_name } = {}) => {
      try {
        const resolvedPath = hasPathParams ? withPathParams(path, path_params) : path;
        return ok(await apiRequest(method.toUpperCase(), resolvedPath, query, body, company_name));
      } catch (error) {
        return err(error);
      }
    }
  );
}

function registerListedPennylaneEndpoints() {
  const endpoints = [
    // DEPRECTAED
    { name: "get_webhook_subscription",title: "Webhook · Retrieve the webhook subscription",description: "Returns the webhook subscription for the authenticated token (secret not included).",method: "GET",path: "/webhook_subscription",hasQuery: false},
    { name: "pl_post_webhook_subscription", title: "Webhook · Creates a webhook subscription", description: "POST /webhook_subscription", method: "POST", path: "/webhook_subscription", hasQuery: false, hasBody: true },
    { name: "pl_put_webhook_subscription", title: "Webhook · Update the webhook subscription", description: "PUT /webhook_subscription", method: "PUT", path: "/webhook_subscription", hasQuery: false, hasBody: true },
    { name: "pl_delete_webhook_subscription", title: "Webhook · Delete the webhook subscription", description: "DELETE /webhook_subscription", method: "DELETE", path: "/webhook_subscription", hasQuery: false },
    { name: "pl_post_pro_account_mandate_mail_requests", title: "Mandate migration candidates · Send a mandate request for a Pro Account SEPA Direct Debit mandate to a customer", description: "POST /pro_account/mandate_requests", method: "POST", path: "/pro_account/mandate_requests", hasQuery: false, hasBody: true },
    
    
    /*** UPDATED 18/06/2026   ***/
    // Journals
    { name: "pl_get_journals", title: "Journals · List journals", description: "Returns journals ordered by descending IDs The old ledger scope will only work on the old behavior system.", method: "GET", path: "/journals", hasQuery: true },
    { name: "pl_get_journal", title: "Journals · Retrieve a journal", description: "Retrieve a journal, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), journals:readonly, journals:all", method: "GET", path: "/journals/{id}", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_postjournals", title: "Journals · Create a journal", description: "Create a journal, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), journals:all", method: "POST", path: "/journals", hasPathParams: false, hasQuery: true, hasBody: true },
    
    // Ledger Accounts
    { name: "pl_get_ledger_accounts", title: "Ledger Accounts · List Ledger Accounts", description: "List Ledger Accounts, DEPRECATED BEHAVIOR: By default, returns ledger accounts ordered by ascending IDs, NEW BEHAVIOR: By default, returns ledger accounts ordered by descending IDs The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_accounts:readonly, ledger_accounts:all", method: "GET", path: "/ledger_accounts", hasQuery: true },
    { name: "pl_doc_getledgeraccount", title: "Ledger Accounts · Get a ledger account", description: "Get a ledger account, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_accounts:readonly, ledger_accounts:all", method: "GET", path: "/ledger_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postledgeraccounts", title: "Ledger Accounts · Create a ledger account", description: "Create a ledger account, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_accounts:all", method: "POST", path: "/ledger_accounts", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_updateledgeraccount", title: "Ledger Accounts · Update a ledger account", description: "Update a ledger account, This endpoint requires the following scope: ledger_accounts:all", method: "PUT", path: "/ledger_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    
    // Ledger Attachments
    { name: "pl_post_ledger_attachments", title: "Upload a file to attach to a ledger entry", description: "Upload a file to attach to a ledger entry. The maximum allowed file size is 100MB. Note that this will not upload a file into the DMS (GED). This endpoint is DEPRECATED As an alternative, please use the File Attachments: Upload a file endpoint. This endpoint requires the following scope: ledger", method: "POST", path: "/ledger_attachments", hasQuery: false, hasBody: true },
    
    // Ledger Entries
    { name: "pl_get_ledger_entries", title: "Ledger Entries · Returns a list of ledger entries.", description: "Returns a list of ledger entries. DEPRECATED BEHAVIOR: Draft entries are filtered out. By default, entries from fiscal periods that are closed or frozen are excluded. However, if a 'date' filter is provided, it will return all entries within the specified date range, even if they fall within a closed or frozen fiscal period. NEW BEHAVIOR : By default, all entries (including draft ones) are rendered regardless of their fiscal year status (open, closed, or frozen). The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entries", hasQuery: true },
    { name: "pl_doc_getledgerentriesledgerentrylines", title: "Ledger Entries · List ledger entry lines of a Ledger Entry", description: "List ledger entry lines of a Ledger Entry, DEPRECATED BEHAVIOR: By default, returns ledger entry lines ordered by ascending IDs, NEW BEHAVIOR: By default, returns ledger entry lines ordered by descending IDs The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entries/{ledger_entry_id}/ledger_entry_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentry", title: "Ledger Entries · Retrieve a ledger entry", description: "Retrieve a ledger entry, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entries/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postledgerentries", title: "Ledger Entries · Create a ledger entry", description: "Create a ledger entry, DEPRECATED BEHAVIOR: The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:all", method: "POST", path: "/ledger_entries", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putledgerentries", title: "Ledger Entries · Update a ledger entry", description: "Update a ledger entry, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:all", method: "PUT", path: "/ledger_entries/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
  
    // Ledger Entry Lines
    { name: "pl_get_ledger_entry_lines", title: "Ledger Entry Lines · List ledger entry lines", description: "List ledger entry lines, This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entry_lines", hasQuery: true },
    { name: "pl_doc_getledgerentryline", title: "Ledger Entry Lines · Retrieve a ledger entry line", description: "Retrieve a ledger entry line, This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entry_lines/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinesletteredledgerentrylines", title: "Ledger Entry Lines · List ledger entry lines lettered to a given ledger entry line", description: "List ledger entry lines lettered to a given ledger entry line, DEPRECATED BEHAVIOR: The items rendered are sorted ordered by ascending id. NEW BEHAVIOR: The items rendered are sorted ordered by descending id by default. A new sort param is available to customize the sorting behavior (see \"sort\" query parameter description). The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entry_lines/{ledger_entry_line_id}/lettered_ledger_entry_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinescategories", title: "Ledger Entry Lines · List categories of a Ledger Entry line", description: "List categories of a Ledger Entry line, NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/ledger_entry_lines/{ledger_entry_line_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putledgerentrylinescategories", title: "Ledger Entry Lines · Replaces already existing categories on the Ledger Entry line with new values", description: "This endpoint replaces already existing categories on the Ledger Entry line with new values. If an empty array of categories_ids is provided, it will remove all categories from the Ledger Entry line. NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:all", method: "PUT", path: "/ledger_entry_lines/{ledger_entry_line_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postledgerentrylinesletter", title: "Ledger Entry Lines · Letter ledger entry lines together.", description: "This endpoint lets you letter ledger entry lines together. All received entry lines will be lettered together. If a passed entry line is already lettered, then the lettering will be applied to its associated lettered entry lines as well. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:all", method: "POST", path: "/ledger_entry_lines/lettering", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_deleteledgerentrylinesunletter", title: "Ledger Entry Lines · Unletter ledger entry lines.", description: "This endpoint lets you unletter ledger entry lines. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:all", method: "DELETE", path: "/ledger_entry_lines/lettering", hasPathParams: false, hasQuery: true, hasBody: false },
    
    // Trial balance
    { name: "pl_get_trial_balance", title: "Trial balance · Returns the trial balance of the current company for the given period", description: "This endpoint returns the trial balance of the current company for the given period. DEPRECATED BEHAVIOR: page and per_page params are deprecated. Please use cursor and limit for pagination instead. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires the following scope: trial_balance:readonly", method: "GET", path: "/trial_balance", hasQuery: true },
    
    // Fiscal Years
    { name: "pl_get_fiscal_years", title: "Fiscal Years · Returns a list of fiscal years of the company.", description: "This endpoint returns a list of fiscal years of the company. DEPRECATED BEHAVIOR: By default, returns fiscal years ordered by ascending start date. NEW BEHAVIOR: By default, returns fiscal years ordered by descending IDs A new sort query parameter is now available allowing to sort by id or start attributes. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires the following scope: fiscal_years:readonly", method: "GET", path: "/fiscal_years", hasQuery: true },
    
    // Exports
    { name: "pl_post_exports_analytical_general_ledgers", title: "Exports · Create an Analytical General Ledger export", description: "This endpoint allows you to create an Analytical General Ledger export. The generated export file is an xlsx file, using the in-line analytical mode by default. This endpoint requires the following scope: exports:agl", method: "POST", path: "/exports/analytical_general_ledgers", hasQuery: false, hasBody: true },
    { name: "pl_doc_getanalyticalgeneralledgerexport", title: "Exports · Returns a specific Analytical General Ledger export", description: "The endpoint returns a specific Analytical General Ledger export. The export file is an xlsx file, using the in-line analytical mode. This endpoint requires the following scope: exports:agl", method: "GET", path: "/exports/analytical_general_ledgers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_exportgeneralledger", title: "Exports · Create a General Ledger export", description: "This endpoint allows you to create a General Ledger export. The generated export file is an xlsx file. This endpoint requires the following scope: exports:gl", method: "POST", path: "/exports/general_ledgers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_getgeneralledgerexport", title: "Exports · Returns a specific General Ledger export", description: "The endpoint returns a specific General Ledger export. The export file is an xlsx file. This endpoint requires the following scope: exports:gl", method: "GET", path: "/exports/general_ledgers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_exportfec", title: "Exports · Create a FEC export", description: "This endpoint allows you to create a FEC export, This endpoint requires the following scope: exports:fec", method: "POST", path: "/exports/fecs", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_getfecexport", title: "Exports · Returns a specific FEC export", description: "The endpoint returns a specific FEC export, This endpoint requires the following scope: exports:fec", method: "GET", path: "/exports/fecs/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    
    // Category Groups
    { name: "pl_get_category_groups", title: "Category Groups · Returns a list of category groups", description: "This endpoint returns a list of category groups. This endpoint requires one of the following scopes: categories:all, categories:readonly", method: "GET", path: "/category_groups", hasQuery: true },
    { name: "pl_doc_getcategorygroup", title: "Category Groups · Returns a specific category group", description: "This endpoint returns a specific category group. This endpoint requires one of the following scopes: categories:all, categories:readonly", method: "GET", path: "/category_groups/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    
    // Categories
    { name: "pl_get_category_group_categories", title: "Categories · List categories of a category group", description: "List categories of a category group. This endpoint requires one of the following scopes: categories:all, categories:readonly", method: "GET", path: "/category_groups/{category_group_id}/categories", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getcategories", title: "Categories · List categories", description: "List categories. This endpoint requires one of the following scopes: categories:all, categories:readonly", method: "GET", path: "/categories", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcategory", title: "Categories · Returns a specific category", description: "This endpoint returns a specific category. This endpoint requires one of the following scopes: categories:all, categories:readonly", method: "GET", path: "/categories/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcategories", title: "Categories · Create a category", description: "Create a category. This endpoint requires the following scope: categories:all", method: "POST", path: "/categories", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatecategory", title: "Categories · Updates a category", description: "This endpoint updates a category. This endpoint requires the following scope: categories:all", method: "PUT", path: "/categories/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    
    // Billing Subscriptions
    { name: "pl_get_billing_subscriptions", title: "Billing Subscriptions · Returns a list of subscriptions", description: "This endpoint returns a list of subscriptions. This endpoint requires one of the following scopes: billing_subscriptions:all, billing_subscriptions:readonly", method: "GET", path: "/billing_subscriptions", hasQuery: true },
    { name: "pl_doc_getbillingsubscription", title: "Billing Subscriptions · Returns a specific billing subscription", description: "This endpoint returns a specific billing subscription. This endpoint requires one of the following scopes: billing_subscriptions:all, billing_subscriptions:readonly", method: "GET", path: "/billing_subscriptions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postbillingsubscriptions", title: "Billing Subscriptions · Create a subscription", description: "This endpoint allows you to create a subscription. Pennylane will generate the customer invoice each month. You can also link the subscription to a GoCardless mandate. This endpoint requires the following scope: billing_subscriptions:all", method: "POST", path: "/billing_subscriptions", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putbillingsubscriptions", title: "Billing Subscriptions · Update a billing subscription", description: "Update a billing subscription. This endpoint requires the following scope: billing_subscriptions:all", method: "PUT", path: "/billing_subscriptions/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getbillingsubscriptioninvoicelines", title: "Billing Subscriptions · List invoice lines for a billing subscription", description: "List invoice lines for a billing subscription. This endpoint requires one of the following scopes: billing_subscriptions:all, billing_subscriptions:readonly", method: "GET", path: "/billing_subscriptions/{billing_subscription_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getbillingsubscriptioninvoicelinesections", title: "Billing Subscriptions · List the invoice line sections of a billing subscription", description: "List the invoice line sections of a billing subscription. This endpoint requires one of the following scopes: billing_subscriptions:all, billing_subscriptions:readonly", method: "GET", path: "/billing_subscriptions/{billing_subscription_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    
    // Changelogs
    { name: "pl_get_changelogs_customer_invoices", title: "Changelogs · Get customer invoices changes events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/changelogs/customer_invoices", hasQuery: true },
    { name: "pl_doc_getsupplierinvoiceschanges", title: "Changelogs · Get supplier invoices changes events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/changelogs/supplier_invoices", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerchanges", title: "Changelogs · Get customer changes events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/changelogs/customers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierchanges", title: "Changelogs · Get supplier changes events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: suppliers:all, suppliers:readonly", method: "GET", path: "/changelogs/suppliers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getproductchanges", title: "Changelogs · Get product change events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: products:all, products:readonly", method: "GET", path: "/changelogs/products", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinechanges", title: "Changelogs · Get ledger entry line change events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). NEW BEHAVIOR : The old ledger scope will only work on the old behavior system. As soon as you opt in to the new version, or when the sunset phase starts and you haven't explicitly opted out of the old behavior, the ledger scope will no longer work. For more details, see our API documentation https://pennylane.readme.io/docs/2026-api-changes-guide for migration instructions. This endpoint requires one of the following scopes: ledger (DEPRECATED), ledger_entries:readonly, ledger_entries:all", method: "GET", path: "/changelogs/ledger_entry_lines", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactionchanges", title: "Changelogs · Get transaction change events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: transactions:all, transactions:readonly", method: "GET", path: "/changelogs/transactions", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquotechanges", title: "Changelogs · Get quotes changes events", description: "Returns the list of changes based on the provided start_date. If no start_date is provided it returns the oldest set of recorded changes. Changes for the last 4 weeks are retained. The items will be returned using processed_at in ASC order (oldest first). This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/changelogs/quotes", hasPathParams: false, hasQuery: true, hasBody: false },

    // Commercial Documents
    { name: "pl_get_commercial_documents", title: "Commercial Documents · List commercial documents", description: "This endpoint lists commercial documents. This endpoint requires one of the following scopes: commercial_documents:all, commercial_documents:readonly", method: "GET", path: "/commercial_documents", hasQuery: true },
    { name: "pl_doc_getcommercialdocument", title: "Commercial Documents · Retrieve a commercial document", description: "This endpoint retrieves a commercial document. This endpoint requires one of the following scopes: commercial_documents:all, commercial_documents:readonly", method: "GET", path: "/commercial_documents/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentinvoicelinesections", title: "Commercial Documents · List invoice line sections for a commercial document", description: "List invoice line sections for a commercial document. This endpoint requires one of the following scopes: commercial_documents:all, commercial_documents:readonly", method: "GET", path: "/commercial_documents/{commercial_document_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentinvoicelines", title: "Commercial Documents · List invoice lines for a commercial document", description: "List invoice lines for a commercial document. This endpoint requires one of the following scopes: commercial_documents:all, commercial_documents:readonly", method: "GET", path: "/commercial_documents/{commercial_document_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentappendices", title: "Commercial Documents · List appendices of a commercial document", description: "List appendices of a commercial document. This endpoint requires one of the following scopes: commercial_documents:all, commercial_documents:readonly", method: "GET", path: "/commercial_documents/{commercial_document_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcommercialdocumentappendices", title: "Commercial Documents · Upload an appendix for a commercial document", description: "Upload a file that will be an appendix attached to a commercial document. Note that this will not upload a file into the DMS (GED). This endpoint requires the following scope: commercial_documents:all", method: "POST", path: "/commercial_documents/{commercial_document_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    
    // Customer Invoices
    { name: "pl_get_customer_invoices", title: "Customer Invoices · Invoices List customer invoices", description: "List customer invoices and credit notes. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices", hasQuery: true },
    { name: "pl_doc_getcustomerinvoiceinvoicelinesections", title: "Customer Invoices · List invoice line sections for a customer invoice", description: "List invoice line sections for a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoiceinvoicelines", title: "Customer Invoices · List invoice lines for a customer invoice", description: "List invoice lines for a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicepayments", title: "Customer Invoices · List payments for a customer invoice", description: "List payments for a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/payments", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicematchedtransactions", title: "Customer Invoices · List matched transactions for a customer invoice", description: "List matched transactions for a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoiceappendices", title: "Customer Invoices · List appendices of a customer invoice", description: "List appendices of a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicecategories", title: "Customer Invoices · List categories of a customer invoice", description: "List categories of a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoice", title: "Customer Invoices · Retrieve a customer invoice", description: "Retrieve a customer invoice or a credit note. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcustomerinvoiceappendices", title: "Customer Invoices · Upload an appendix for a customer invoice", description: "Upload a file that will be an appendix attached to a customer invoice. Note that this will not upload a file into the DMS (GED). This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/{customer_invoice_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_sendbyemailcustomerinvoice", title: "Customer Invoices · Send a customer invoice by email", description: "This endpoint allows you to send a finalized, imported customer invoice or credit note by email to your customer. This requires that the PDF file for that document has been generated (this process can take a few minutes), so if you just created the invoice in our system, we may return a 409 error. You should retry the request in a few minutes - if you receive a 204 response, that means that the email is on its way. For more information about email sending, please read this guide. This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/{id}/send_by_email", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postcustomerinvoices", title: "Customer Invoices · Create a customer invoice", description: "This endpoint allows you to send a finalized, imported customer invoice or credit note by email to your customer. This requires that the PDF file for that document has been generated (this process can take a few minutes), so if you just created the invoice in our system, we may return a 409 error. You should retry the request in a few minutes - if you receive a 204 response, that means that the email is on its way. For more information about email sending, please read this guide. This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_importcustomerinvoices", title: "Customer Invoices · Import an invoice with file attached", description: "This endpoint allows you to import an invoice. To ensure consistency, we will apply validations on amounts in accordance with our rounding policy. We allow a difference up to 1 cent per invoice_line between the total amounts and the sum of invoice lines. For further details, please refer to our article on rounding policy. This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/import", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_linkcreditnote", title: "Customer Invoices · Link a credit note to a customer invoice", description: "Link a credit note to a customer invoice. This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/{id}/link_credit_note", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_createcustomerinvoicefromquote", title: "Customer Invoices · Create a customer invoice from a quote", description: "This endpoint allows you to create a customer invoice from an existing quote. The invoice will inherit the quote's data (customer, lines, etc.). This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/create_from_quote", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_createcustomerinvoiceeinvoiceimport", title: "Customer Invoices · Import a customer e-invoice", description: "Import a customer invoice from an e-invoice file (Factur-X format). The file must be a valid Factur-X PDF. Optionally provide invoice_options to pre-fill customer and line-level data. Invoice line e_invoice_line_id must match Factur-X BT-126 (LineID). This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/e_invoices/imports", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_sendtopacustomerinvoice", title: "Customer Invoices · Send a customer e-invoice to PA", description: "Send a customer e-invoice to the Partner Dematerialization Platform (PA). This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/{id}/send_to_pa", hasPathParams: true, hasQuery: false, hasBody: false },
    { name: "pl_doc_updatecustomerinvoice", title: "Customer Invoices · Update a customer invoice", description: "Update a customer invoice. This endpoint requires the following scope: customer_invoices:all", method: "PUT", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_markaspaidcustomerinvoice", title: "Customer Invoices · Mark a customer invoice as paid", description: "Mark a customer invoice as paid. No automatic reconciliation will be done once the invoice is marked as paid. This endpoint requires the following scope: customer_invoices:all", method: "PUT", path: "/customer_invoices/{id}/mark_as_paid", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putcustomerinvoicecategories", title: "Customer Invoices · Categorize a customer invoice", description: "This endpoint is not applicable for draft invoices. Update the categories of a customer invoice. You can pass categories that don't belong to the same category group. The sum of categories of a same group must equal 1. In the following example, the two first categories belong to the same category group A, the sum of the weights is 1. The third category belongs to a category group B, its weight is 1.[{ \"id\": 59, \"weight\": \"0.5\" }, // category group A { \"id\": 33, \"weight\": \"0.5\" }, // category group A { \"id\": 65, \"weight\": \"1\" } // category group B ]. This endpoint requires the following scope: customer_invoices:all", method: "PUT", path: "/customer_invoices/{customer_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updateimportedcustomerinvoice", title: "Customer Invoices · Update an Imported customer invoice", description: "Update an imported customer invoice or credit note. It is not applicable for draft invoices. This endpoint requires the following scope: customer_invoices:all", method: "PUT", path: "/customer_invoices/{id}/update_imported", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_finalizecustomerinvoice", title: "Customer Invoices · Turn the draft invoice into a finalized invoice", description: "Convert the draft customer invoice or credit note into a finalized one. Once finalized, the resource can no longer be edited. This endpoint requires the following scope: customer_invoices:all", method: "PUT", path: "/customer_invoices/{id}/finalize", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_deletecustomerinvoices", title: "Customer Invoices · Delete draft invoice", description: "Delete a draft customer invoice or draft credit note. This endpoint requires the following scope: customer_invoices:all", method: "DELETE", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicecustomheaderfields", title: "Customer Invoices · List custom header fields for a customer invoice", description: "List custom header fields for a customer invoice. This endpoint requires one of the following scopes: customer_invoices:all, customer_invoices:readonly", method: "GET", path: "/customer_invoices/{customer_invoice_id}/custom_header_fields", hasPathParams: true, hasQuery: true, hasBody: false },
  
    // Products
    { name: "pl_get_product", title: "Products · List products", description: "List products. This endpoint requires one of the following scopes: products:all, products:readonly", method: "GET", path: "/products/{id}", hasPathParams: true, hasQuery: false },
    { name: "pl_doc_getproduct", title: "Products · Retrieve a product", description: "Retrieve a product. This endpoint requires one of the following scopes: products:all, products:readonly", method: "GET", path: "/products/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postproducts_1", title: "Products · Create a product", description: "Create a product. This endpoint requires the following scope: products:all", method: "POST", path: "/products", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putproduct", title: "Products · Update a product", description: "Update a product. This endpoint requires the following scope: products:all", method: "PUT", path: "/products/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
  
    // Customer Invoice Templates
    { name: "pl_get_customer_invoice_templates", title: "Customer Invoice Templates · List customer invoice templates", description: "List customer invoice templates. This endpoint requires the following scope: customer_invoice_templates:readonly", method: "GET", path: "/customer_invoice_templates", hasQuery: true },
    
    // Customers
    { name: "pl_get_company_customer", title: "Customers · Retrieve a company customer", description: "This endpoint returns a company customer. This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/company_customers/{id}", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getindividualcustomer", title: "Customers · Retrieve an individual customer", description: "This endpoint returns an individual customer. This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/individual_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomers", title: "Customers · List customers (company and individual)", description: "This endpoint returns a list of both company and individual customers. This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/customers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomer", title: "Customers · Retrieve a customer", description: "This endpoint returns a customer. This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/customers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcompanycustomer", title: "Customers · Create a company customer", description: "This endpoint returns the created company customer. This endpoint requires the following scope: customers:all", method: "POST", path: "/company_customers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postindividualcustomer", title: "Customers · Create an individual customer", description: "This endpoint returns the created individual customer. This endpoint requires the following scope: customers:all", method: "POST", path: "/individual_customers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putcompanycustomer", title: "Customers · Update a company customer", description: "This endpoint returns the updated company customer. This endpoint requires the following scope: customers:all", method: "PUT", path: "/company_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putindividualcustomer", title: "Customers · Update an individual customer", description: "This endpoint returns the updated individual customer. This endpoint requires the following scope: customers:all", method: "PUT", path: "/individual_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getcustomercontacts", title: "Customers · List contacts of a customer", description: "List contacts of a customer. This endpoint requires one of the following scopes: customers:all, customers:readonly", method: "GET", path: "/customers/{customer_id}/contacts", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomercategories", title: "Customers · List categories of a customer", description: "List categories of a customer. This endpoint requires one of the following scopes: customers:readonly, customers:all", method: "GET", path: "/customers/{customer_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putcustomercategories", title: "Customers · Categorize a customer", description: "Update the categories of a customer. You can pass categories that don't belong to the same category group. The sum of categories of a same group must equal 1. In the following example, the two first categories belong to the same category group A, the sum of the weights is 1. The third category belongs to a category group B, its weight is 1. [  { \"id\": 59, \"weight\": \"0.5\" }, // category group A  { \"id\": 33, \"weight\": \"0.5\" }, // category group A { \"id\": 65, \"weight\": \"1\" }    // category group B ] This endpoint requires the following scope: customers:all", method: "PUT", path: "/customers/{customer_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },

    // E-Invoices
    { name: "pl_post_einvoices_imports", title: "[BETA] Import e-invoices", description: "This endpoint allows you to import an e-invoice. This endpoint is DEPRECATED As an alternative, please use either: Import a customer e-invoice endpoint, Import a supplier e-invoice endpoint. This endpoint requires the following scope: e_invoices:all", method: "POST", path: "/e-invoices/imports", hasQuery: false, hasBody: true },
    
    // File Attachments
    { name: "pl_post_file_attachments", title: "File Attachments · Upload a file to attach to any resource that provides a file_attachment_id", description: "Upload a file to attach to any resource that provides a file_attachment_id. The maximum allowed file size is 100MB. Note that this will not upload a file into the DMS (GED). This endpoint requires the following scope: file_attachments:all", method: "POST", path: "/file_attachments", hasQuery: false, hasBody: true },
  
    // Mandates
    { name: "pl_post_sepa_mandates", title: "Mandates · Create a SEPA mandate", description: "This endpoint allows you to create a SEPA mandate to enable direct debit payments. This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/sepa_mandates", hasQuery: true, hasBody: true },
    { name: "pl_doc_getsepamandates", title: "Mandates · List SEPA mandates", description: "This endpoint allows you to retrieve all SEPA mandates associated with your company. This endpoint requires one of the following scopes: customer_mandates:all, customer_mandates:readonly", method: "GET", path: "/sepa_mandates", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsepamandate", title: "Mandates · Get a SEPA mandate", description: "This endpoint allows you to retrieve a specific SEPA mandate by ID. This endpoint requires one of the following scopes: customer_mandates:all, customer_mandates:readonly", method: "GET", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_pro_account_mandate_migrations", title: "Mandates · List mandate migration candidates", description: "This endpoint allows you to retrieve all mandate migration candidates for your company. These are mandates that can be migrated to a Pro Account. Requirements: Company must have a Pro Account (returns 404 if not). Company must have an enabled merchant profile (returns 403 if not). This endpoint requires one of the following scopes: customer_mandates:readonly, customer_mandates:all", method: "GET", path: "/pro_account/mandate_migrations", hasQuery: true },
    { name: "pl_post_pro_account_mandate_mail_requests", title: "Mandates · Send a Pro Account SEPA mandate request", description: "This endpoint allows you to send a mandate request for a Pro Account SEPA Direct Debit mandate to a customer. Requirements: Company must have a Pro Account (returns 404 if not). Company must have an enabled merchant profile (returns 403 if not). This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/pro_account/mandate_requests", hasQuery: false, hasBody: true },
    { name: "pl_post_pro_account_mandate_migrations", title: "Mandates · Migrate a mandate to a Pro Account", description: "This endpoint allows you to migrate a mandate to a Pro Account. Only mandates with status 'available' are eligible for migration. Requirements: Company must have a Pro Account (returns 404 if not). Company must have an enabled merchant profile (returns 403 if not). This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/pro_account/mandate_migrations", hasQuery: false, hasBody: true },
    { name: "pl_doc_putsepamandate", title: "Mandates · Update a SEPA mandate", description: "This endpoint allows you to update an existing SEPA mandate. This endpoint requires the following scope: customer_mandates:all", method: "PUT", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_pro_account_mandates", title: "Mandates · List Pro Account payment mandates", description: "This endpoint allows you to retrieve all payment mandates associated with your company's pro account. Requirements: Company must have a Pro Account (returns 404 if not). Company must have an enabled merchant profile (returns 403 if not). This endpoint requires one of the following scopes: customer_mandates:readonly, customer_mandates:all", method: "GET", path: "/pro_account/mandates", hasQuery: true },
    { name: "pl_doc_deletesepamandate", title: "Mandates · Delete a SEPA mandate", description: "This endpoint allows you to delete a specific SEPA mandate. This endpoint requires the following scope: customer_mandates:all", method: "DELETE", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getgocardlessmandates", title: "Mandates · List gocardless mandates", description: "List gocardless mandates. This endpoint requires one of the following scopes: customer_mandates:all, customer_mandates:readonly", method: "GET", path: "/gocardless_mandates", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getgocardlessmandate", title: "Mandates · Get a Gocardless mandate", description: "This endpoint allows you to retrieve a specific Gocardless mandate by ID. This endpoint requires one of the following scopes: customer_mandates:all, customer_mandates:readonly", method: "GET", path: "/gocardless_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postgocardlessmandatemailrequests", title: "Mandates · Send a GoCardless mandate email request", description: "This endpoint allows you to send an email request for a GoCardless mandate to a recipient. This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/gocardless_mandates/mail_requests", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postgocardlessmandateassociations", title: "Mandates · Associate a GoCardless mandate to a customer", description: "This endpoint allows you to associate a GoCardless mandate to a customer. This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/gocardless_mandates/{gocardless_mandate_id}/associations", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postgocardlessmandatecancellations", title: "Mandates · Cancel a Gocardless mandate", description: "Cancels a specific Gocardless mandate by ID. The mandate must be in a cancellable state, having one of the following statuses: pending_submission, submitted or active. This endpoint requires the following scope: customer_mandates:all", method: "POST", path: "/gocardless_mandates/{gocardless_mandate_id}/cancellations", hasPathParams: true, hasQuery: true, hasBody: true },
   
    // Quotes
    { name: "pl_get_quotes", title: "Quotes · List quotes", description: "Lists quotes. This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/quotes", hasQuery: true },
    { name: "pl_doc_getquote", title: "Quotes · Retrieve a quote", description: "This endpoint retrieves a quote. This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/quotes/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteinvoicelinesections", title: "Quotes · List invoice line sections for a quote", description: "List invoice line sections for a quote. This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/quotes/{quote_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteinvoicelines", title: "Quotes · List invoice lines for a quote", description: "List invoice lines for a quote. This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/quotes/{quote_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteappendices", title: "Quotes · List appendices of a quote", description: "List appendices of a quote. This endpoint requires one of the following scopes: quotes:all, quotes:readonly", method: "GET", path: "/quotes/{quote_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postquotes", title: "Quotes · Create a quote", description: "This endpoint allows you to create a quote. This endpoint requires the following scope: quotes:all", method: "POST", path: "/quotes", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postquoteappendices", title: "Quotes · Upload an appendix for a quote", description: "Upload a file that will be an appendix attached to a quote. Note that this will not upload a file into the DMS (GED). This endpoint requires the following scope: quotes:all", method: "POST", path: "/quotes/{quote_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_sendbyemailquote", title: "Quotes · Send a quote by email", description: "This endpoint allows you to send a quote by email to your customer. This requires that the PDF file for that document has been generated (this process can take a few minutes), so if you just created the quote in our system, we may return a 409 error. You should retry the request in a few minutes - if you receive a 204 response, that means that the email is on its way. For more information about email sending, please read [this guide](https://pennylane.readme.io/v2.0/docs/sending-documents-by-email). This endpoint requires the following scope: quotes:all", method: "POST", path: "/quotes/{id}/send_by_email", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatequote", title: "Quotes · Update a quote", description: "This endpoint allows you to update a quote. This endpoint requires the following scope: quotes:all", method: "PUT", path: "/quotes/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatestatusquote", title: "Quotes · Update status of a quote", description: "This endpoint allows you to update the status of a quote. This endpoint requires the following scope: quotes:all", method: "PUT", path: "/quotes/{id}/update_status", hasPathParams: true, hasQuery: true, hasBody: true },
  
    // Supplier Invoices
    { name: "pl_get_supplier_invoice_lines", title: "Supplier Invoices · List invoice lines for a supplier invoice", description: "List invoice lines for a supplier invoice. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/invoice_lines", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getsupplierinvoices", title: "Supplier Invoices · List supplier invoices", description: "This endpoint returns a list of supplier invoices. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoice", title: "Supplier Invoices · Retrieve a supplier invoice", description: "This endpoint returns a supplier invoice. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicecategories", title: "Supplier Invoices · List categories of a supplier invoice", description: "List categories of a supplier invoice. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicepayments", title: "Supplier Invoices · List payments for a supplier invoice", description: "List payments for a supplier invoice. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/payments", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicematchedtransactions", title: "Supplier Invoices · List matched transactions for a supplier invoice", description: "List matched transactions for a supplier invoice. This endpoint requires one of the following scopes: supplier_invoices:all, supplier_invoices:readonly", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_importsupplierinvoice", title: "Supplier Invoices · Import a supplier invoice with a file attached", description: "This endpoint allows you to import a supplier invoice with a file attached. This endpoint requires the following scope: supplier_invoices:all", method: "POST", path: "/supplier_invoices/import", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postsupplierinvoicelinkedpurchaserequests", title: "Supplier Invoices · Link a purchase request to a supplier invoice", description: "This endpoint allows you to link a purchase request to a supplier invoice. You can link one purchase request with one supplier invoice at a time. To link multiple purchase request to a supplier invoice, you need to call this endpoint multiple times. It's possible to link a purchase request to multiple supplier invoices too. This endpoint requires the following scope: supplier_invoices:all", method: "POST", path: "/supplier_invoices/{supplier_invoice_id}/linked_purchase_requests", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_createsupplierinvoiceeinvoiceimport", title: "Supplier Invoices · Import a supplier e-invoice", description: "Import a supplier invoice from an e-invoice file (Factur-X format). The file must be a valid Factur-X PDF. Optionally provide invoice_options to pre-fill supplier and line-level data. Invoice line e_invoice_line_id must match Factur-X BT-126 (LineID). This endpoint requires the following scope: supplier_invoices:all", method: "POST", path: "/supplier_invoices/e_invoices/imports", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoice", title: "Supplier Invoices · Update a supplier invoice", description: "This endpoint allows you to update a supplier invoice. This endpoint requires the following scope: supplier_invoices:all", method: "PUT", path: "/supplier_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoicecategories", title: "Supplier Invoices · Categorize a supplier invoice", description: "Update the categories of a supplier invoice. You can pass categories that don't belong to the same category group. The sum of categories of a same group must equal 1. In the following example, the two first categories belong to the same category group A, the sum of the weights is 1. The third category belongs to a category group B, its weight is 1. [ { \"id\": 59, \"weight\": \"0.5\" }, // category group A   { \"id\": 33, \"weight\": \"0.5\" }, // category group A   { \"id\": 65, \"weight\": \"1\" } // category group B ] This endpoint requires the following scope: supplier_invoices:all", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatesupplierinvoicepaymentstatus", title: "Supplier Invoices · Update a supplier invoice payment status", description: "This endpoint allows you to update the payment status of a supplier invoice. This endpoint requires the following scope: supplier_invoices:all", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/payment_status", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_validateaccountingsupplierinvoice", title: "Supplier Invoices · Validate the accounting of a supplier invoice", description: "Turn the supplier invoice into a Complete state. This endpoint requires the following scope: supplier_invoices:all", method: "PUT", path: "/supplier_invoices/{id}/validate_accounting", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoiceeinvoicestatus", title: "Supplier Invoices · Update e-invoice status for a supplier invoice", description: "Applies an electronic invoicing lifecycle transition: dispute, refuse, or undispute (approved). Dispute and refuse require a reason. This endpoint requires the following scope: supplier_invoices:all", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/e_invoice_status", hasPathParams: true, hasQuery: true, hasBody: true },
  
    // Purchase Requests
    { name: "pl_get_purchase_requests", title: "Purchase Requests · List purchase requests", description: "List purchase requests. This endpoint requires one of the following scopes: purchase_requests:all, purchase_requests:readonly", method: "GET", path: "/purchase_requests", hasQuery: true },
    { name: "pl_doc_getpurchaserequest", title: "Purchase Requests · Retrieve a purchase request", description: "Retrieve a purchase request. This endpoint requires one of the following scopes: purchase_requests:all, purchase_requests:readonly", method: "GET", path: "/purchase_requests/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_createpurchaserequestimport", title: "Purchase Requests · Import a purchase order", description: "Import a purchase order. This will create a purchase request with an existing purchase order attached. The purchase request will be automatically validated. This endpoint requires the following scope: purchase_requests:all", method: "POST", path: "/purchase_requests/imports", hasPathParams: false, hasQuery: true, hasBody: true },
   
    // Suppliers
    { name: "pl_get_suppliers", title: "Suppliers · List suppliers", description: "List suppliers. This endpoint requires one of the following scopes: suppliers:all, suppliers:readonly", method: "GET", path: "/suppliers", hasQuery: true },
    { name: "pl_doc_getsupplier", title: "Suppliers · Retrieve a supplier", description: "This endpoint returns a supplier. This endpoint requires one of the following scopes: suppliers:all, suppliers:readonly", method: "GET", path: "/suppliers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postsupplier", title: "Suppliers · Create a Supplier", description: "This endpoint returns the created supplier. This endpoint requires the following scope: suppliers:all", method: "POST", path: "/suppliers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplier", title: "Suppliers · Update a supplier", description: "This endpoint returns the updated supplier. This endpoint requires the following scope: suppliers:all", method: "PUT", path: "/suppliers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getsuppliercategories", title: "Suppliers · List categories of a supplier", description: "List categories of a supplier. This endpoint requires one of the following scopes: suppliers:readonly, suppliers:all", method: "GET", path: "/suppliers/{supplier_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putsuppliercategories", title: "Suppliers · Categorize a supplier", description: "Update the categories of a supplier. You can pass categories that don't belong to the same category group. The sum of categories of a same group must equal 1. In the following example, the two first categories belong to the same category group A, the sum of the weights is 1. The third category belongs to a category group B, its weight is 1. [{ \"id\": 59, \"weight\": \"0.5\" }, // category group A { \"id\": 33, \"weight\": \"0.5\" }, // category group A { \"id\": 65, \"weight\": \"1\" }    // category group B ] This endpoint requires the following scope: suppliers:all", method: "PUT", path: "/suppliers/{supplier_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },

    // Bank Accounts
    { name: "pl_get_bank_establishments", title: "Bank Accounts · List bank establishments", description: "List bank establishments. This endpoint requires the following scope: bank_establishments:readonly", method: "GET", path: "/bank_establishments", hasQuery: true },
    { name: "pl_doc_getbankaccounts", title: "Bank Accounts · List bank accounts", description: "List bank_accounts. This endpoint requires one of the following scopes: bank_accounts:all, bank_accounts:readonly", method: "GET", path: "/bank_accounts", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getbankaccount", title: "Bank Accounts · Retrieve a bank account", description: "Retrieve a bank account. This endpoint requires one of the following scopes: bank_accounts:all, bank_accounts:readonly", method: "GET", path: "/bank_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postbankaccount", title: "Bank Accounts · Create a bank account", description: "Create a bank account. This endpoint requires the following scope: bank_accounts:all", method: "POST", path: "/bank_accounts", hasPathParams: false, hasQuery: true, hasBody: true },

    // Transactions
    { name: "pl_get_transactions", title: "Transactions · List transactions", description: "List transactions. This endpoint requires one of the following scopes: transactions:readonly, transactions:all", method: "GET", path: "/transactions", hasQuery: true },
    { name: "pl_doc_gettransaction", title: "Transactions · Retrieve a transaction", description: "Retrieve a transaction. This endpoint requires one of the following scopes: transactions:readonly, transactions:all", method: "GET", path: "/transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactionmatchedinvoices", title: "Transactions · List invoices matched to a bank transaction", description: "List invoices matched to a bank transaction. This endpoint requires one of the following scopes: transactions:readonly, transactions:all", method: "GET", path: "/transactions/{transaction_id}/matched_invoices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactioncategories", title: "Transactions · List categories of a bank transaction", description: "List categories of a bank transaction. This endpoint requires one of the following scopes: transactions:readonly, transactions:all", method: "GET", path: "/transactions/{transaction_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_createtransaction", title: "Transactions · Create a transaction", description: "Create a banking transaction. This endpoint requires the following scope: transactions:all", method: "POST", path: "/transactions", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postcustomerinvoicematchedtransactions", title: "Transactions · Match a transaction to a customer invoice", description: "This endpoint allows you to match a transaction to a customer invoice. It is not applicable for draft invoices. You can match one transaction with one customer invoice at a time. To match multiple transactions to a customer invoice, you need to call this endpoint multiple times. It's possible to match a transaction to multiple customer invoices too. This endpoint requires the following scope: customer_invoices:all", method: "POST", path: "/customer_invoices/{customer_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postsupplierinvoicematchedtransactions", title: "Transactions · Match a transaction to a supplier invoice", description: "This endpoint allows you to match a transaction to a supplier invoice. You can match one transaction with one supplier invoice at a time. To match multiple transactions to a supplier invoice, you need to call this endpoint multiple times. It's possible to match a transaction to multiple supplier invoices too. This endpoint requires the following scope: supplier_invoices:all", method: "POST", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_puttransactioncategories", title: "Transactions · Categorize a bank transaction", description: "Update the categories of a transaction. You can pass categories that don't belong to the same category group. The sum of categories of a same group must equal 1. In the following example, the two first categories belong to the same category group A, the sum of the weights is 1. The third category belongs to a category group B, its weight is 1. [ { \"id\": 59, \"weight\": \"0.5\" }, // category group A { \"id\": 33, \"weight\": \"0.5\" }, // category group A { \"id\": 65, \"weight\": \"1\" } // category group B ] This endpoint requires the following scope: transactions:all", method: "PUT", path: "/transactions/{transaction_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatetransaction", title: "Transactions · Update a transaction", description: "This endpoint returns the updated transaction. This endpoint requires the following scope: transactions:all", method: "PUT", path: "/transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_deletecustomerinvoicematchedtransactions", title: "Transactions · Unmatch a transaction to a customer invoice", description: "This endpoint allows you to unmatch a transaction to a customer invoice. It is not applicable for draft invoices. This endpoint requires the following scope: customer_invoices:all", method: "DELETE", path: "/customer_invoices/{customer_invoice_id}/matched_transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_deletesupplierinvoicematchedtransactions", title: "Transactions · Unmatch a transaction to a supplier invoice", description: "This endpoint allows you to unmatch a transaction to a supplier invoice. This endpoint requires the following scope: supplier_invoices:all", method: "DELETE", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    
    // Users
    { name: "pl_get_me", title: "Users · User Profile", description: "This endpoint returns information about the company and the user associated to the token.", method: "GET", path: "/me", hasQuery: false },
    
    // PA Registrations
    { name: "pl_get_pa_registrations", title: "PA Registrations · List PA Registrations", description: "Returns all PA (Plateforme Agrée) registrations for the company, including activation status and exchange direction. Use this to determine whether the company has completed PA onboarding. Records with a null siret represent the SIREN-level (head office), other records represent establishments. This endpoint requires the following scope: pa_registrations:readonly", method: "GET", path: "/pa_registrations", hasQuery: false }
  ];

  endpoints.sort((a, b) => {
    const ca = categoryFromPath(a.path);
    const cb = categoryFromPath(b.path);
    if (ca !== cb) return ca.localeCompare(cb, "fr");

    const ra = resourceFromPath(a.path);
    const rb = resourceFromPath(b.path);
    if (ra !== rb) return ra.localeCompare(rb, "fr");

    const aa = actionFromMethod(a.method);
    const ab = actionFromMethod(b.method);
    if (aa !== ab) return aa.localeCompare(ab, "fr");

    return a.name.localeCompare(b.name, "fr");
  });

  for (const endpoint of endpoints) {
    registerStaticEndpointTool(endpoint);
  }

  return endpoints.length;
}

server.registerTool(
  "pennylane_request",
  {
    title: "Generic HTTP · Pennylane",
    description: "Generic HTTP request to the Pennylane v2 API (GET/POST/PUT/DELETE).",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Méthode HTTP"),
      path: z.string().describe("Chemin API commençant par /, ex: /customers"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query params optionnels"),
      body: z.record(z.any()).optional().describe("Corps JSON ou multipart via { __multipart: true, file_path, file_field_name?, filename?, content_type?, fields? }"),
      company_name: z.string().optional().describe("Nom de la société à utiliser pour cette requête (sinon, société active courante).")
    },
    annotations: { ...WRITE_TOOL, title: "Generic HTTP · Pennylane" }
  },
  async ({ method, path, query, body, company_name }) => {
    try {
      return ok(await apiRequest(method, path, query, body, company_name));
    } catch (error) {
      return err(error);
    }
  }
);

server.registerTool(
  "pl_list_companies",
  {
    title: "Sociétés · Lister les sociétés disponibles",
    description: "Liste les sociétés Pennylane configurées (jusqu'à 5) et indique celle qui est actuellement active.",
    inputSchema: {},
    annotations: { ...READ_ONLY, title: "Sociétés · Lister les sociétés disponibles" }
  },
  async () => {
    try {
      const list = companies.map((c) => ({
        slot: c.slot,
        name: c.name,
        active: c.name === activeCompany.name
      }));
      return ok({
        active: activeCompany.name,
        count: companies.length,
        companies: list
      });
    } catch (error) {
      return err(error);
    }
  }
);

server.registerTool(
  "pl_switch_company",
  {
    title: "Sociétés · Changer la société active",
    description: "Change la société Pennylane active à utiliser pour les requêtes suivantes, identifiée par son nom.",
    inputSchema: {
      company_name: z.string().describe("Nom de la société à activer (doit correspondre à un nom configuré).")
    },
    annotations: { ...WRITE_TOOL, title: "Sociétés · Changer la société active" }
  },
  async ({ company_name }) => {
    try {
      const found = findCompanyByName(company_name);
      if (!found) {
        const available = companies.map((c) => c.name).join(", ");
        throw new Error(`Société inconnue: "${company_name}". Sociétés disponibles: ${available}`);
      }
      activeCompany = found;
      return ok({
        message: `Société active: ${activeCompany.name}`,
        active: activeCompany.name,
        slot: activeCompany.slot
      });
    } catch (error) {
      return err(error);
    }
  }
);

const listedEndpointsCount = registerListedPennylaneEndpoints();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Pennylane MCP Server démarré");
console.error(`🏢 Sociétés configurées: ${companies.length} (${companies.map((c) => c.name).join(", ")})`);
console.error(`🎯 Société active: ${activeCompany.name}`);
console.error(`📌 Endpoints explicitement déclarés: ${listedEndpointsCount}`);
