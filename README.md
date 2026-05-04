# Pennylane MCP

Serveur **MCP** (bundle MCPB) pour l'API externe Pennylane v2.

## Installation (utilisateur)

1. Télécharger le fichier `pennylane-mcp-vX.Y.Z.mcpb` depuis les [Releases](https://github.com/anasweepo/pennylane-mcp-server/releases) du dépôt.
2. **Settings -> Extensions -> Install from file...** (ou double-clic sur le `.mcpb`).
3. Renseigner le **Pennylane API Token**.
4. Cliquer **Install**.

Le `.mcpb` est produit par la CI sur chaque tag `v*`, pas dans l'archive ZIP du code source.

Il expose :

- un outil dédié pour `GET /webhook_subscription`
- un outil HTTP générique (`GET/POST/PUT/DELETE`)
- tous les endpoints Pennylane v2 `GET/POST/PUT/DELETE` auto-générés depuis la spec OpenAPI

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

Dans la configuration MCP, renseigner :

- `PENNYLANE_API_TOKEN` (injecté via `user_config.pennylane_api_token` dans `manifest.json`)

Le serveur ajoute automatiquement l'en-tête :

```http
Authorization: Bearer <token>
```

## Outils MCP exposés

- `get_webhook_subscription` : récupère la souscription webhook du token courant
- `pennylane_request` : requête HTTP générique avec `method`, `path`, `query`, `body`
- `pl_*` : outils auto-générés à partir des `operationId` (ou du couple méthode+path) de la spec OpenAPI

Exemples d'outils auto-générés :

- `pl_getcustomers`
- `pl_createcustomer`
- `pl_getinvoices`

Le serveur charge la spec au démarrage depuis :

- `https://pennylane.readme.io/openapi` (par défaut)
- ou `PENNYLANE_OPENAPI_URL` si vous voulez surcharger la source

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
PENNYLANE_API_TOKEN=xxxxx node index.js
```

## Publier une version

Aligner `version` dans `manifest.json` avec le tag, puis :

```bash
git add manifest.json
git commit -m "chore: bump version to 1.0.1"
git tag v1.0.1
git push origin main --tags
```

Le workflow `.github/workflows/release.yml` valide le manifest, génère le `.mcpb` et l'attache automatiquement à la GitHub Release.
