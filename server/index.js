import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const API_TOKEN = process.env.PENNYLANE_API_TOKEN;
const BASE = "https://app.pennylane.com/api/external/v2";

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

  const friendlyMeta = buildFriendlyToolMeta(method, path, title, description);

  server.registerTool(
    name,
    {
      title: friendlyMeta.title,
      description: friendlyMeta.description,
      inputSchema,
      annotations: { ...annotationForMethod(method), title: friendlyMeta.title }
    },
    async ({ path_params, query, body } = {}) => {
      try {
        const resolvedPath = hasPathParams ? withPathParams(path, path_params) : path;
        return ok(await apiRequest(method.toUpperCase(), resolvedPath, query, body));
      } catch (error) {
        return err(error);
      }
    }
  );
}

function registerListedPennylaneEndpoints() {
  const endpoints = [
    { name: "get_webhook_subscription",title: "Webhook · Retrieve the webhook subscription",description: "Returns the webhook subscription for the authenticated token (secret not included).",method: "GET",path: "/webhook_subscription",hasQuery: false},
    { name: "pl_post_webhook_subscription", title: "Webhook · Creates a webhook subscription", description: "POST /webhook_subscription", method: "POST", path: "/webhook_subscription", hasQuery: false, hasBody: true },
    { name: "pl_put_webhook_subscription", title: "Webhook · Update the webhook subscription", description: "PUT /webhook_subscription", method: "PUT", path: "/webhook_subscription", hasQuery: false, hasBody: true },
    { name: "pl_delete_webhook_subscription", title: "Webhook · Delete the webhook subscription", description: "DELETE /webhook_subscription", method: "DELETE", path: "/webhook_subscription", hasQuery: false },
    { name: "pl_get_pro_account_mandate_migrations", title: "Mandate migration candidates · Retrieve all mandate migration candidates for your company", description: "GET /pro_account/mandate_migrations", method: "GET", path: "/pro_account/mandate_migrations", hasQuery: true },
    { name: "pl_post_pro_account_mandate_migrations", title: "Mandate migration candidates · Migrate a mandate to a Pro Account", description: "POST /pro_account/mandate_migrations", method: "POST", path: "/pro_account/mandate_migrations", hasQuery: false, hasBody: true },
    { name: "pl_post_pro_account_mandate_mail_requests", title: "Mandate migration candidates · Send a mandate request for a Pro Account SEPA Direct Debit mandate to a customer", description: "POST /pro_account/mandate_requests", method: "POST", path: "/pro_account/mandate_requests", hasQuery: false, hasBody: true },
    { name: "pl_get_journals", title: "Journals · List journals", description: "GET /journals", method: "GET", path: "/journals", hasQuery: true },
    { name: "pl_get_journal", title: "Journals · Retrieve a journal", description: "Retrieve a journal Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions", method: "GET", path: "/journals/{id}", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_postjournals", title: "Journals · Create a journal", description: "Create a journal Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a journal JUMP", method: "POST", path: "/journals", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_get_ledger_accounts", title: "Ledger Accounts · List Ledger Accounts", description: "GET /ledger_accounts", method: "GET", path: "/ledger_accounts", hasQuery: true },
    { name: "pl_doc_getledgeraccount", title: "Ledger Accounts · Get a ledger account", description: "Get a ledger account Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get a ledger accou", method: "GET", path: "/ledger_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postledgeraccounts", title: "Ledger Accounts · Create a ledger account", description: "Create a ledger account Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a ledger", method: "POST", path: "/ledger_accounts", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_updateledgeraccount", title: "Ledger Accounts · Update a ledger account", description: "Update a ledger account Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a ledger", method: "PUT", path: "/ledger_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_post_ledger_attachments", title: "Upload a file to attach to a ledger entry", description: "POST /ledger_attachments", method: "POST", path: "/ledger_attachments", hasQuery: false, hasBody: true },
    { name: "pl_get_ledger_entries", title: "Ledger Entries · Returns a list of ledger entries.", description: "GET /ledger_entries", method: "GET", path: "/ledger_entries", hasQuery: true },
    { name: "pl_doc_getledgerentriesledgerentrylines", title: "Ledger Entries · List ledger entry lines of a Ledger Entry", description: "List ledger entry lines of a Ledger Entry Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Stat", method: "GET", path: "/ledger_entries/{ledger_entry_id}/ledger_entry_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentry", title: "Ledger Entries · Retrieve a ledger entry", description: "Retrieve a Ledger entry Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a Ledg", method: "GET", path: "/ledger_entries/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postledgerentries", title: "Ledger Entries · Create a ledger entry", description: "Create a ledger entry Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a ledger e", method: "POST", path: "/ledger_entries", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putledgerentries", title: "Ledger Entries · Update a ledger entry", description: "Update a ledger entry Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a ledger e", method: "PUT", path: "/ledger_entries/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_ledger_entry_lines", title: "Ledger Entry Lines · List ledger entry lines", description: "GET /ledger_entry_lines", method: "GET", path: "/ledger_entry_lines", hasQuery: true },
    { name: "pl_doc_getledgerentryline", title: "Ledger Entry Lines · Retrieve a ledger entry line", description: "Retrieve a Ledger entry line Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a", method: "GET", path: "/ledger_entry_lines/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinesletteredledgerentrylines", title: "Ledger Entry Lines · List ledger entry lines lettered to a given ledger entry line", description: "List ledger entry lines lettered to a given ledger entry line Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Di", method: "GET", path: "/ledger_entry_lines/{ledger_entry_line_id}/lettered_ledger_entry_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinescategories", title: "Ledger Entry Lines · List categories of a Ledger Entry line", description: "List categories of a Ledger Entry line Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status", method: "GET", path: "/ledger_entry_lines/{ledger_entry_line_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putledgerentrylinescategories", title: "Ledger Entry Lines · Replaces already existing categories on the Ledger Entry line with new values", description: "Link Analytical Categories to a Ledger Entry line Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪", method: "PUT", path: "/ledger_entry_lines/{ledger_entry_line_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postledgerentrylinesletter", title: "Ledger Entry Lines · Letter ledger entry lines together.", description: "Letter ledger entry lines Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Letter ledger", method: "POST", path: "/ledger_entry_lines/lettering", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_deleteledgerentrylinesunletter", title: "Ledger Entry Lines · Unletter ledger entry lines.", description: "Unletter ledger entry lines Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Unletter le", method: "DELETE", path: "/ledger_entry_lines/lettering", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_get_trial_balance", title: "Trial balance · Returns the trial balance of the current company for the given period", description: "GET /trial_balance", method: "GET", path: "/trial_balance", hasQuery: true },
    { name: "pl_get_fiscal_years", title: "Fiscal Years · Returns a list of fiscal years of the company.", description: "GET /fiscal_years", method: "GET", path: "/fiscal_years", hasQuery: true },
    { name: "pl_post_exports_analytical_general_ledgers", title: "Exports · Create an Analytical General Ledger export", description: "POST /exports/analytical_general_ledgers", method: "POST", path: "/exports/analytical_general_ledgers", hasQuery: false, hasBody: true },
    { name: "pl_doc_getanalyticalgeneralledgerexport", title: "Exports · Returns a specific Analytical General Ledger export", description: "Retrieve an Analytical General Ledger export Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API S", method: "GET", path: "/exports/analytical_general_ledgers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_exportgeneralledger", title: "Exports · Create a General Ledger export", description: "Create a General Ledger export Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a", method: "POST", path: "/exports/general_ledgers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_getgeneralledgerexport", title: "Exports · Returns a specific General Ledger export", description: "Retrieve a General Ledger export Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrie", method: "GET", path: "/exports/general_ledgers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_exportfec", title: "Exports · Create a FEC export", description: "Create a FEC export Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a FEC export", method: "POST", path: "/exports/fecs", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_getfecexport", title: "Exports · Returns a specific FEC export", description: "Retrieve a FEC export Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a FEC ex", method: "GET", path: "/exports/fecs/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_category_groups", title: "Category Groups · Returns a list of category groups", description: "GET /category_groups", method: "GET", path: "/category_groups", hasQuery: true },
    { name: "pl_doc_getcategorygroup", title: "Category Groups · Returns a specific category group", description: "Retrieve a category group Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a ca", method: "GET", path: "/category_groups/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_category_group_categories", title: "Categories · List categories of a category group", description: "GET /category_groups/{category_group_id}/categories", method: "GET", path: "/category_groups/{category_group_id}/categories", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getcategories", title: "Categories · List categories", description: "List categories Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List categories JUMP TO", method: "GET", path: "/categories", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcategory", title: "Categories · Returns a specific category", description: "Retrieve a category Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a category", method: "GET", path: "/categories/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcategories", title: "Categories · Create a category", description: "Create a category Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a category JUM", method: "POST", path: "/categories", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatecategory", title: "Categories · Updates a category", description: "Update a category Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a category JUM", method: "PUT", path: "/categories/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_billing_subscriptions", title: "Billing Subscriptions · Returns a list of subscriptions", description: "GET /billing_subscriptions", method: "GET", path: "/billing_subscriptions", hasQuery: true },
    { name: "pl_doc_getbillingsubscription", title: "Billing Subscriptions · Returns a specific billing subscription", description: "Get a billing subscription Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get a billin", method: "GET", path: "/billing_subscriptions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postbillingsubscriptions", title: "Billing Subscriptions · Create a subscription", description: "Create a billing subscription Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a", method: "POST", path: "/billing_subscriptions", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putbillingsubscriptions", title: "Billing Subscriptions · Update a billing subscription", description: "Update a billing subscription Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a", method: "PUT", path: "/billing_subscriptions/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getbillingsubscriptioninvoicelines", title: "Billing Subscriptions · List invoice lines for a billing subscription", description: "List invoice lines for a billing subscription Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API", method: "GET", path: "/billing_subscriptions/{billing_subscription_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getbillingsubscriptioninvoicelinesections", title: "Billing Subscriptions · List the invoice line sections of a billing subscription", description: "List the invoice line sections of a billing subscription Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discuss", method: "GET", path: "/billing_subscriptions/{billing_subscription_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_changelogs_customer_invoices", title: "Changelogs · Get customer invoices changes events", description: "GET /changelogs/customer_invoices", method: "GET", path: "/changelogs/customer_invoices", hasQuery: true },
    { name: "pl_doc_getsupplierinvoiceschanges", title: "Changelogs · Get supplier invoices changes events", description: "Get supplier invoices changes events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Ge", method: "GET", path: "/changelogs/supplier_invoices", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerchanges", title: "Changelogs · Get customer changes events", description: "Get customer changes events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get custome", method: "GET", path: "/changelogs/customers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierchanges", title: "Changelogs · Get supplier changes events", description: "Get supplier changes events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get supplie", method: "GET", path: "/changelogs/suppliers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getproductchanges", title: "Changelogs · Get product change events", description: "Get product change events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get product c", method: "GET", path: "/changelogs/products", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getledgerentrylinechanges", title: "Changelogs · Get ledger entry line change events", description: "Get ledger entry line change events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get", method: "GET", path: "/changelogs/ledger_entry_lines", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactionchanges", title: "Changelogs · Get transaction change events", description: "Get transaction change events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get trans", method: "GET", path: "/changelogs/transactions", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquotechanges", title: "Changelogs · Get quotes changes events", description: "Get quotes changes events Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get quotes ch", method: "GET", path: "/changelogs/quotes", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_get_commercial_documents", title: "Commercial Documents · List commercial documents", description: "GET /commercial_documents", method: "GET", path: "/commercial_documents", hasQuery: true },
    { name: "pl_doc_getcommercialdocument", title: "Commercial Documents · Retrieve a commercial document", description: "Retrieve a commercial document Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve", method: "GET", path: "/commercial_documents/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentinvoicelinesections", title: "Commercial Documents · List invoice line sections for a commercial document", description: "List invoice line sections for a commercial document Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions", method: "GET", path: "/commercial_documents/{commercial_document_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentinvoicelines", title: "Commercial Documents · List invoice lines for a commercial document", description: "List invoice lines for a commercial document Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API S", method: "GET", path: "/commercial_documents/{commercial_document_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcommercialdocumentappendices", title: "Commercial Documents · List appendices of a commercial document", description: "List appendices of a commercial document Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Statu", method: "GET", path: "/commercial_documents/{commercial_document_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcommercialdocumentappendices", title: "Commercial Documents · Upload an appendix for a commercial document", description: "Upload an appendix for a commercial document Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API S", method: "POST", path: "/commercial_documents/{commercial_document_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_customer_invoices", title: "Customer Invoices · Invoices List customer invoices", description: "GET /customer_invoices", method: "GET", path: "/customer_invoices", hasQuery: true },
    { name: "pl_doc_getcustomerinvoiceinvoicelinesections", title: "Customer Invoices · List invoice line sections for a customer invoice", description: "List invoice line sections for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪", method: "GET", path: "/customer_invoices/{customer_invoice_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoiceinvoicelines", title: "Customer Invoices · List invoice lines for a customer invoice", description: "List invoice lines for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Stat", method: "GET", path: "/customer_invoices/{customer_invoice_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicepayments", title: "Customer Invoices · List payments for a customer invoice", description: "List payments for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Li", method: "GET", path: "/customer_invoices/{customer_invoice_id}/payments", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicematchedtransactions", title: "Customer Invoices · List matched transactions for a customer invoice", description: "List matched transactions for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ A", method: "GET", path: "/customer_invoices/{customer_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoiceappendices", title: "Customer Invoices · List appendices of a customer invoice", description: "List appendices of a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status L", method: "GET", path: "/customer_invoices/{customer_invoice_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicecategories", title: "Customer Invoices · List categories of a customer invoice", description: "List categories of a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status L", method: "GET", path: "/customer_invoices/{customer_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoice", title: "Customer Invoices · Retrieve a customer invoice", description: "Retrieve a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a", method: "GET", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcustomerinvoiceappendices", title: "Customer Invoices · Upload an appendix for a customer invoice", description: "Upload an appendix for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Stat", method: "POST", path: "/customer_invoices/{customer_invoice_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_sendbyemailcustomerinvoice", title: "Customer Invoices · Send a customer invoice by email", description: "Send a customer invoice by email Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Send a", method: "POST", path: "/customer_invoices/{id}/send_by_email", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postcustomerinvoices", title: "Customer Invoices · Create a customer invoice", description: "Create a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a cust", method: "POST", path: "/customer_invoices", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_importcustomerinvoices", title: "Customer Invoices · Import an invoice with file attached", description: "Import an invoice with file attached Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Im", method: "POST", path: "/customer_invoices/import", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_linkcreditnote", title: "Customer Invoices · Link a credit note to a customer invoice", description: "Link a credit note to a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Statu", method: "POST", path: "/customer_invoices/{id}/link_credit_note", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_createcustomerinvoicefromquote", title: "Customer Invoices · Create a customer invoice from a quote", description: "Create a customer invoice from a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status", method: "POST", path: "/customer_invoices/create_from_quote", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_createcustomerinvoiceeinvoiceimport", title: "Customer Invoices · Import a customer e-invoice", description: "Import a customer e-invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Import a cu", method: "POST", path: "/customer_invoices/e_invoices/imports", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatecustomerinvoice", title: "Customer Invoices · Update a customer invoice", description: "Update a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a cust", method: "PUT", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_markaspaidcustomerinvoice", title: "Customer Invoices · Mark a customer invoice as paid", description: "Mark a customer invoice as paid Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Mark a", method: "PUT", path: "/customer_invoices/{id}/mark_as_paid", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putcustomerinvoicecategories", title: "Customer Invoices · Categorize a customer invoice", description: "Categorize a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Categoriz", method: "PUT", path: "/customer_invoices/{customer_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updateimportedcustomerinvoice", title: "Customer Invoices · Update an Imported customer invoice", description: "Update an Imported customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Upd", method: "PUT", path: "/customer_invoices/{id}/update_imported", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_finalizecustomerinvoice", title: "Customer Invoices · Turn the draft invoice into a finalized invoice", description: "Turn the draft invoice into a finalized invoice.", method: "PUT", path: "/customer_invoices/{id}/finalize", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_deletecustomerinvoices", title: "Customer Invoices · Delete draft invoice", description: "Delete draft invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Delete draft invoi", method: "DELETE", path: "/customer_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomerinvoicecustomheaderfields", title: "Customer Invoices · List custom header fields for a customer invoice", description: "List custom header fields for a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ A", method: "GET", path: "/customer_invoices/{customer_invoice_id}/custom_header_fields", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_product", title: "Products · List products", description: "GET /products/{id}", method: "GET", path: "/products/{id}", hasPathParams: true, hasQuery: false },
    { name: "pl_doc_getproduct", title: "Products · Retrieve a product", description: "Retrieve a product Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a product J", method: "GET", path: "/products/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postproducts_1", title: "Products · Create a product", description: "Create a product", method: "POST", path: "/products", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putproduct", title: "Products · Update a product", description: "Update a product Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a product JUMP", method: "PUT", path: "/products/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_customer_invoice_templates", title: "Customer Invoice Templates · List customer invoice templates", description: "GET /customer_invoice_templates", method: "GET", path: "/customer_invoice_templates", hasQuery: true },
    { name: "pl_get_company_customer", title: "Customers · Retrieve a company customer", description: "GET /company_customers/{id}", method: "GET", path: "/company_customers/{id}", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getindividualcustomer", title: "Customers · Retrieve an individual customer", description: "Retrieve an individual customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retriev", method: "GET", path: "/individual_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomers", title: "Customers · List customers (company and individual)", description: "List customers (company and individual) Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status", method: "GET", path: "/customers", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomer", title: "Customers · Retrieve a customer", description: "Retrieve a customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a customer", method: "GET", path: "/customers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postcompanycustomer", title: "Customers · Create a company customer", description: "Create a company customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a comp", method: "POST", path: "/company_customers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postindividualcustomer", title: "Customers · Create an individual customer", description: "Create an individual customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create an", method: "POST", path: "/individual_customers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putcompanycustomer", title: "Customers · Update a company customer", description: "Update a company customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a comp", method: "PUT", path: "/company_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putindividualcustomer", title: "Customers · Update an individual customer", description: "Update an individual customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update an", method: "PUT", path: "/individual_customers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getcustomercontacts", title: "Customers · List contacts of a customer", description: "List contacts of a customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List contac", method: "GET", path: "/customers/{customer_id}/contacts", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getcustomercategories", title: "Customers · List categories of a customer", description: "List categories of a customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List cate", method: "GET", path: "/customers/{customer_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putcustomercategories", title: "Customers · Categorize a customer", description: "Categorize a customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Categorize a cust", method: "PUT", path: "/customers/{customer_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_post_einvoices_imports", title: "[BETA] Import e-invoices", description: "POST /e-invoices/imports", method: "POST", path: "/e-invoices/imports", hasQuery: false, hasBody: true },
    { name: "pl_post_file_attachments", title: "File Attachments · Upload a file to attach to any resource that provides a file_attachment_id", description: "POST /file_attachments", method: "POST", path: "/file_attachments", hasQuery: false, hasBody: true },
    { name: "pl_post_sepa_mandates", title: "Mandates · Create a SEPA mandate", description: "POST /sepa_mandates", method: "POST", path: "/sepa_mandates", hasQuery: true, hasBody: true },
    { name: "pl_doc_getsepamandates", title: "Mandates · List SEPA mandates", description: "List SEPA mandates Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List SEPA mandates J", method: "GET", path: "/sepa_mandates", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsepamandate", title: "Mandates · Get a SEPA mandate", description: "Get a SEPA mandate Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get a SEPA mandate J", method: "GET", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putsepamandate", title: "Mandates · Update a SEPA mandate", description: "Update a SEPA mandate Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a SEPA man", method: "PUT", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_deletesepamandate", title: "Mandates · Delete a SEPA mandate", description: "Delete a SEPA mandate Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Delete a SEPA man", method: "DELETE", path: "/sepa_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getgocardlessmandates", title: "Mandates · List gocardless mandates", description: "List gocardless mandates Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List gocardles", method: "GET", path: "/gocardless_mandates", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getgocardlessmandate", title: "Mandates · Get a Gocardless mandate", description: "Get a Gocardless mandate Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Get a Gocardle", method: "GET", path: "/gocardless_mandates/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postgocardlessmandatemailrequests", title: "Mandates · Send a GoCardless mandate email request", description: "Send a GoCardless mandate email request Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status", method: "POST", path: "/gocardless_mandates/mail_requests", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postgocardlessmandateassociations", title: "Mandates · Associate a GoCardless mandate to a customer", description: "Associate a GoCardless mandate to a customer Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API S", method: "POST", path: "/gocardless_mandates/{gocardless_mandate_id}/associations", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postgocardlessmandatecancellations", title: "Mandates · Cancel a Gocardless mandate", description: "Cancel a Gocardless mandate Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Cancel a Go", method: "POST", path: "/gocardless_mandates/{gocardless_mandate_id}/cancellations", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_quotes", title: "Quotes · List quotes", description: "GET /quotes", method: "GET", path: "/quotes", hasQuery: true },
    { name: "pl_doc_getquote", title: "Quotes · Retrieve a quote", description: "Retrieve a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a quote JUMP", method: "GET", path: "/quotes/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteinvoicelinesections", title: "Quotes · List invoice line sections for a quote", description: "List invoice line sections for a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status", method: "GET", path: "/quotes/{quote_id}/invoice_line_sections", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteinvoicelines", title: "Quotes · List invoice lines for a quote", description: "List invoice lines for a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List inv", method: "GET", path: "/quotes/{quote_id}/invoice_lines", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getquoteappendices", title: "Quotes · List appendices of a quote", description: "List appendices of a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List appendi", method: "GET", path: "/quotes/{quote_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postquotes", title: "Quotes · Create a quote", description: "Create a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a quote JUMP TO P", method: "POST", path: "/quotes", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postquoteappendices", title: "Quotes · Upload an appendix for a quote", description: "Upload an appendix for a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Upload a", method: "POST", path: "/quotes/{quote_id}/appendices", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_sendbyemailquote", title: "Quotes · Send a quote by email", description: "Send a quote by email Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Send a quote by e", method: "POST", path: "/quotes/{id}/send_by_email", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatequote", title: "Quotes · Update a quote", description: "Update a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a quote JUMP TO P", method: "PUT", path: "/quotes/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatestatusquote", title: "Quotes · Update status of a quote", description: "Update status of a quote Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update status", method: "PUT", path: "/quotes/{id}/update_status", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_supplier_invoice_lines", title: "Supplier Invoices · List invoice lines for a supplier invoice", description: "GET /supplier_invoices/{supplier_invoice_id}/invoice_lines", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/invoice_lines", hasPathParams: true, hasQuery: true },
    { name: "pl_doc_getsupplierinvoices", title: "Supplier Invoices · List supplier invoices", description: "List supplier invoices Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List supplier in", method: "GET", path: "/supplier_invoices", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoice", title: "Supplier Invoices · Retrieve a supplier invoice", description: "Retrieve a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a", method: "GET", path: "/supplier_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicecategories", title: "Supplier Invoices · List categories of a supplier invoice", description: "List categories of a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status L", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicepayments", title: "Supplier Invoices · List payments for a supplier invoice", description: "List payments for a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Li", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/payments", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_getsupplierinvoicematchedtransactions", title: "Supplier Invoices · List matched transactions for a supplier invoice", description: "List matched transactions for a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ A", method: "GET", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_importsupplierinvoice", title: "Supplier Invoices · Import a supplier invoice with a file attached", description: "Import a supplier invoice with a file attached Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API", method: "POST", path: "/supplier_invoices/import", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postsupplierinvoicelinkedpurchaserequests", title: "Supplier Invoices · Link a purchase request to a supplier invoice", description: "Link a purchase request to a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API", method: "POST", path: "/supplier_invoices/{supplier_invoice_id}/linked_purchase_requests", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_createsupplierinvoiceeinvoiceimport", title: "Supplier Invoices · Import a supplier e-invoice", description: "Import a supplier e-invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Import a su", method: "POST", path: "/supplier_invoices/e_invoices/imports", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoice", title: "Supplier Invoices · Update a supplier invoice", description: "Update a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a supp", method: "PUT", path: "/supplier_invoices/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoicecategories", title: "Supplier Invoices · Categorize a supplier invoice", description: "Categorize a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Categoriz", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatesupplierinvoicepaymentstatus", title: "Supplier Invoices · Update a supplier invoice payment status", description: "Update a supplier invoice payment status Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Statu", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/payment_status", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_validateaccountingsupplierinvoice", title: "Supplier Invoices · Validate the accounting of a supplier invoice", description: "Validate the accounting of a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API", method: "PUT", path: "/supplier_invoices/{id}/validate_accounting", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplierinvoiceeinvoicestatus", title: "Supplier Invoices · Update e-invoice status for a supplier invoice", description: "Update e-invoice status for a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API", method: "PUT", path: "/supplier_invoices/{supplier_invoice_id}/e_invoice_status", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_purchase_requests", title: "Purchase Requests · List purchase requests", description: "GET /purchase_requests", method: "GET", path: "/purchase_requests", hasQuery: true },
    { name: "pl_doc_getpurchaserequest", title: "Purchase Requests · Retrieve a purchase request", description: "Retrieve a purchase request Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a", method: "GET", path: "/purchase_requests/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_createpurchaserequestimport", title: "Purchase Requests · Import a purchase order", description: "Import a purchase order.", method: "POST", path: "/purchase_requests/imports", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_get_suppliers", title: "Suppliers · List suppliers", description: "GET /suppliers", method: "GET", path: "/suppliers", hasQuery: true },
    { name: "pl_doc_getsupplier", title: "Suppliers · Retrieve a supplier", description: "Retrieve a supplier Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a supplier", method: "GET", path: "/suppliers/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postsupplier", title: "Suppliers · Create a Supplier", description: "Create a Supplier Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a Supplier JUM", method: "POST", path: "/suppliers", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_putsupplier", title: "Suppliers · Update a supplier", description: "Update a supplier Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a supplier JUM", method: "PUT", path: "/suppliers/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_getsuppliercategories", title: "Suppliers · List categories of a supplier", description: "List categories of a supplier Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List cate", method: "GET", path: "/suppliers/{supplier_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_putsuppliercategories", title: "Suppliers · Categorize a supplier", description: "Categorize a supplier Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Categorize a supp", method: "PUT", path: "/suppliers/{supplier_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_get_bank_establishments", title: "Bank Accounts · List bank establishments", description: "GET /bank_establishments", method: "GET", path: "/bank_establishments", hasQuery: true },
    { name: "pl_doc_getbankaccounts", title: "Bank Accounts · List bank accounts", description: "List bank accounts Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status List bank accounts J", method: "GET", path: "/bank_accounts", hasPathParams: false, hasQuery: true, hasBody: false },
    { name: "pl_doc_getbankaccount", title: "Bank Accounts · Retrieve a bank account", description: "Retrieve a bank account Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a bank", method: "GET", path: "/bank_accounts/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_postbankaccount", title: "Bank Accounts · Create a bank account", description: "Create a bank account Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a bank acc", method: "POST", path: "/bank_accounts", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_get_transactions", title: "Transactions · List transactions", description: "GET /transactions", method: "GET", path: "/transactions", hasQuery: true },
    { name: "pl_doc_gettransaction", title: "Transactions · Retrieve a transaction", description: "Retrieve a transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Retrieve a trans", method: "GET", path: "/transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactionmatchedinvoices", title: "Transactions · List invoices matched to a bank transaction", description: "List invoices matched to a bank transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API St", method: "GET", path: "/transactions/{transaction_id}/matched_invoices", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_gettransactioncategories", title: "Transactions · List categories of a bank transaction", description: "List categories of a bank transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status L", method: "GET", path: "/transactions/{transaction_id}/categories", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_createtransaction", title: "Transactions · Create a transaction", description: "Create a transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Create a transacti", method: "POST", path: "/transactions", hasPathParams: false, hasQuery: true, hasBody: true },
    { name: "pl_doc_postcustomerinvoicematchedtransactions", title: "Transactions · Match a transaction to a customer invoice", description: "Match a transaction to a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Stat", method: "POST", path: "/customer_invoices/{customer_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_postsupplierinvoicematchedtransactions", title: "Transactions · Match a transaction to a supplier invoice", description: "Match a transaction to a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Stat", method: "POST", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_puttransactioncategories", title: "Transactions · Categorize a bank transaction", description: "Categorize a bank transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Categoriz", method: "PUT", path: "/transactions/{transaction_id}/categories", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_updatetransaction", title: "Transactions · Update a transaction", description: "Update a transaction Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API Status Update a transacti", method: "PUT", path: "/transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: true },
    { name: "pl_doc_deletecustomerinvoicematchedtransactions", title: "Transactions · Unmatch a transaction to a customer invoice", description: "Unmatch a transaction to a customer invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API St", method: "DELETE", path: "/customer_invoices/{customer_invoice_id}/matched_transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_doc_deletesupplierinvoicematchedtransactions", title: "Transactions · Unmatch a transaction to a supplier invoice", description: "Unmatch a transaction to a supplier invoice Jump to Content Home Guides API Reference Changelog Discussions ⚪ API Status v1.0 v2.0 Log In API Reference Log In v2.0 Home Guides API Reference Changelog Discussions ⚪ API St", method: "DELETE", path: "/supplier_invoices/{supplier_invoice_id}/matched_transactions/{id}", hasPathParams: true, hasQuery: true, hasBody: false },
    { name: "pl_get_me", title: "Users · User Profile", description: "User Profile", method: "GET", path: "/me", hasQuery: false },
    { name: "pl_get_pa_registrations", title: "PA Registrations · List PA Registrations", description: "GET /pa_registrations", method: "GET", path: "/pa_registrations", hasQuery: false }
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
      body: z.record(z.any()).optional().describe("Corps JSON ou multipart via { __multipart: true, file_path, file_field_name?, filename?, content_type?, fields? }")
    },
    annotations: { ...WRITE_TOOL, title: "Generic HTTP · Pennylane" }
  },
  async ({ method, path, query, body }) => {
    try {
      return ok(await apiRequest(method, path, query, body));
    } catch (error) {
      return err(error);
    }
  }
);

const listedEndpointsCount = registerListedPennylaneEndpoints();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ Pennylane MCP Server démarré");
console.error(`📌 Endpoints explicitement déclarés: ${listedEndpointsCount}`);
