# Pennylane MCP

Serveur **MCP** (bundle MCPB) pour l'API externe Pennylane v2.

**Version actuelle :** `1.0.8`

## Installation (utilisateur)
1. Télécharger le fichier `pennylane-mcp-vX.Y.Z.mcpb` depuis les [Releases](https://github.com/anasweepo/pennylane-mcp-server/releases) du dépôt.
2. **Settings -> Extensions -> Install from file...** (ou double-clic sur le `.mcpb`).
3. Renseigner le **Pennylane API Token**.
4. Cliquer **Install**.

Le `.mcpb` est produit par la CI sur chaque tag `v*`, pas dans l'archive ZIP du code source.

Il expose :

- des outils explicites par endpoint Pennylane v2 (liste maintenue dans `registerListedPennylaneEndpoints`)
- une couverture en lecture/écriture (`GET/POST/PUT/DELETE`) selon chaque endpoint déclaré
- des familles d'outils visibles à l'installation (`Webhook`, `Journals`, `Ledger Accounts`, `Customer Invoices`, `Supplier Invoices`, etc.)
- un outil générique `Generic HTTP · Pennylane` pour les cas manuels (`method`, `path`, `query`, `body`)

Documentation endpoint webhook: [Get a webhook subscription](https://pennylane.readme.io/reference/getwebhooksubscription)  
Spec OpenAPI: [Pennylane OpenAPI](https://pennylane.readme.io/openapi)

## Structure

```text
pennylane-mcp/
├── manifest.json
├── README.md
└── server/
    ├── index.js
    └── package.json
```

## Configuration

Le serveur supporte jusqu'à **7 sociétés Pennylane**. Chaque société se configure avec un couple `token` + `nom`.

Dans la configuration MCP de l'extension, renseigner pour chaque société à utiliser :
- `Société N · Pennylane API Token` → injecté via `PENNYLANE_API_TOKEN_N`
- `Société N · Nom` → injecté via `PENNYLANE_COMPANY_NAME_N`

(`N` = 1 à 7. La société 1 est obligatoire, les autres sont optionnelles.)

Un token legacy `PENNYLANE_API_TOKEN` (sans suffixe) reste aussi supporté pour une configuration mono-société.

Le serveur ajoute automatiquement l'en-tête correspondant à la **société active** :
```http
Authorization: Bearer <token_de_la_societe_active>
```

### Switcher entre sociétés

Deux outils dédiés permettent de gérer la société active :

- `pl_list_companies` : liste les sociétés configurées et indique laquelle est active.
- `pl_switch_company` : change la société active à partir de son nom (`company_name`).

En complément, **chaque outil accepte un paramètre optionnel `company_name`** pour effectuer une requête ponctuelle sur une autre société sans changer la société active.

## Outils MCP exposés

Outils MCP exposés à l'installation :

- `Sociétés` : lister les sociétés Pennylane configurées (jusqu'à 7) et changer la société active par nom (`pl_list_companies`, `pl_switch_company`)
- `Webhook` : [Expiré] souscription webhook (lecture, création, mise à jour, suppression)
- `Journals` : consultation et création de journaux comptables
- `Ledger Accounts` : gestion des comptes généraux
- `Ledger Entries` : gestion des écritures comptables
- `Ledger Entry Lines` : lignes d'écriture, lettrage et catégorisation
- `Exports` : exports comptables (AGL, GL, FEC)
- `Category Groups / Categories` : groupes de catégories et catégories analytiques
- `Billing Subscriptions` : abonnements de facturation et lignes associées
- `Changelogs` : flux de changements (factures, clients, fournisseurs, transactions...)
- `Commercial Documents` : documents commerciaux, annexes et lignes
- `Customer Invoices` : factures clients, e-factures, envoi PA, pièces jointes, statuts, catégories
- `Products` : catalogue produits
- `Customers` : clients société/individuels, contacts et catégories
- `Mandates` : mandats SEPA, migration de mandats et GoCardless
- `Quotes` : devis, annexes et statuts
- `Supplier Invoices` : factures fournisseurs, catégories, paiements et e-invoices
- `Purchase Requests` : demandes d'achat et imports
- `Suppliers` : fournisseurs et catégories
- `Bank Accounts / Transactions` : comptes bancaires, transactions et rapprochements
- `Users / PA Registrations` : profil utilisateur et informations PA registrations

## APIs traitées (détail)

Le serveur couvre les endpoints suivants (lecture + écriture selon les cas) :

- **Webhook** : `/webhook_subscription` (`GET`, `POST`, `PUT`, `DELETE`)
- **Mandate migration candidates** : `/pro_account/mandate_migrations`, `/pro_account/mandate_requests`
- **Journals** : `/journals`, `/journals/{id}`
- **Ledger Accounts** : `/ledger_accounts`, `/ledger_accounts/{id}`
- **Ledger Entries** : `/ledger_entries`, `/ledger_entries/{id}`, `/ledger_entries/{ledger_entry_id}/ledger_entry_lines`
- **Ledger Entry Lines** : `/ledger_entry_lines`, `/ledger_entry_lines/{id}`, `/ledger_entry_lines/lettering`, `/ledger_entry_lines/{ledger_entry_line_id}/categories`
- **Comptabilité globale** : `/trial_balance`, `/fiscal_years`
- **Exports** : `/exports/analytical_general_ledgers`, `/exports/general_ledgers`, `/exports/fecs` (+ `/{id}`)
- **Category Groups / Categories** : `/category_groups`, `/category_groups/{id}`, `/category_groups/{category_group_id}/categories`, `/categories`, `/categories/{id}`
- **Billing Subscriptions** : `/billing_subscriptions`, `/billing_subscriptions/{id}` et sous-ressources `invoice_lines` / `invoice_line_sections`
- **Changelogs** : `/changelogs/customer_invoices`, `/changelogs/supplier_invoices`, `/changelogs/customers`, `/changelogs/suppliers`, `/changelogs/products`, `/changelogs/ledger_entry_lines`, `/changelogs/transactions`, `/changelogs/quotes`
- **Commercial Documents** : `/commercial_documents`, `/commercial_documents/{id}` + `invoice_lines`, `invoice_line_sections`, `appendices`
- **Customer Invoices** : `/customer_invoices`, `/customer_invoices/{id}` + actions (`send_by_email`, `send_to_pa`, `mark_as_paid`, `finalize`, `update_imported`, `link_credit_note`, `create_from_quote`) + imports e-facture (`/customer_invoices/e_invoices/imports`, `/customer_invoices/import`) et sous-ressources (`appendices`, `payments`, `matched_transactions`, `categories`, `custom_header_fields`)
- **Customer Invoice Templates** : `/customer_invoice_templates`
- **Products** : `/products`, `/products/{id}`- **Customers** : `/customers`, `/customers/{id}`, `/company_customers`, `/individual_customers` + `contacts` / `categories`
- **Mandates** : `/sepa_mandates`, `/gocardless_mandates`, `/pro_account/mandates` + actions (`mail_requests`, `associations`, `cancellations`)
- **Quotes** : `/quotes`, `/quotes/{id}` + actions (`send_by_email`, `update_status`) et sous-ressources (`invoice_lines`, `invoice_line_sections`, `appendices`)
- **Supplier Invoices** : `/supplier_invoices`, `/supplier_invoices/{id}` + actions (`payment_status`, `validate_accounting`, `e_invoice_status`) + import e-facture (`/supplier_invoices/e_invoices/imports`, `/supplier_invoices/import`) et sous-ressources (`invoice_lines`, `payments`, `matched_transactions`, `categories`, `linked_purchase_requests`)
- **Purchase Requests** : `/purchase_requests`, `/purchase_requests/{id}`, `/purchase_requests/imports`
- **Suppliers** : `/suppliers`, `/suppliers/{id}`, `/suppliers/{supplier_id}/categories`
- **Bank Accounts / Transactions** : `/bank_establishments`, `/bank_accounts`, `/bank_accounts/{id}`, `/transactions`, `/transactions/{id}` + `matched_invoices` / `categories`
- **Autres** : `/me`, `/pa_registrations`, `/file_attachments`, `/ledger_attachments`, `/e-invoices/imports`

### Upload de fichiers (endpoints multipart)

Pour les endpoints de type upload (ex: `file_attachments`, `ledger_attachments`, `e-invoices/imports`), passe un body multipart :

```json
{
  "__multipart": true,
  "file_path": "C:/chemin/vers/fichier.pdf",
  "file_field_name": "file",
  "filename": "facture.pdf",
  "content_type": "application/pdf",
  "fields": {
    "type": "customer"
  }
}
```

`fields` permet d'ajouter les champs texte du formulaire multipart.

## Lancer en local

```bash
cd server
npm install
# Société 1 (obligatoire)
PENNYLANE_API_TOKEN_1=xxxxx PENNYLANE_COMPANY_NAME_1="Ma Société" \
# Sociétés 2 à 7 (optionnelles)
PENNYLANE_API_TOKEN_2=yyyyy PENNYLANE_COMPANY_NAME_2="Autre Société" \
node index.js
```

## Publier une version

Aligner la version dans `manifest.json`, `server/package.json`, `server/package-lock.json`, `server/index.js` et `README.md`, puis :

```bash
git add manifest.json server/package.json server/package-lock.json server/index.js README.md
git commit -m "chore: bump version to 1.0.8"
git tag v1.0.8
git push origin main --tags
```

Le workflow `.github/workflows/release.yml` vérifie que la version du manifest correspond au tag, valide le bundle, génère le `.mcpb` et l'attache automatiquement à la GitHub Release.