# Handover Document for Claude

Hello Claude! You are picking up the development of the **Alterpop Importer** project. The user is frustrated with the current state of the translation engine and wants a fresh perspective. Below is everything you need to know to hit the ground running.

## 1. Project Overview
- **App**: `alterpop-importer`
- **Stack**: Remix (React), Node.js, Prisma (SQLite), Fly.io (deployment).
- **Purpose**: Ingests massive CSV product feeds from suppliers (like OcioStock - 30,000+ items), applies curation rules, translates content (ES -> EN), calculates margins, and pushes approved products to Shopify.
- **Key Constraints**: High volume of products requires careful memory management, fast processing, and minimizing expensive/slow API calls.

## 2. Recent Major Changes (What was just done)

### A. Performance Fix (7k Indexing Stall)
- **Problem**: The catalog indexing stream was stalling at 7,000 products due to heavy CPU load.
- **Fix**: The curation rules in `lib/importer/curation/structuredCatalogFilter.server.js` were refactored. We implemented pre-compiled rule evaluations, cached Unicode normalizations (`normalizeString`), and reduced the sync batch size in `syncCatalogWithProgress.server.js` from 1000 to 500 to prevent event-loop starvation.
- **Status**: Resolved and deployed.

### B. Translation Engine Architecture (The Current Pain Point)
- **Problem**: Translating 30,000 products via DeepL/OpenAI per import is too slow and expensive.
- **Current Solution**: We implemented a **Dictionary-Based Token Substitution Engine**. 
  - File: `lib/importer/transform/glossary/titles.json` (Structured by source language: `{"es": {"term": "translated"}}`).
  - Logic: `translateTitleFromGlossary.js` loads the dictionary, sorts keys by length (to catch phrases like "El Señor de los Anillos" before single words), and does Regex replacements.
  - Tags: `translate.js` was just updated to also pass the `franchises` array through `translateCategory` so tags like "PELÍCULAS" translate to "Movies" using `categories.json`.
  - Auto-Discovery: We created a script `extractUnknownTerms.js` that parses the CSV and outputs the most frequent untranslated words to `data/unknown_terms.json`.
  - Automation: A script was just run to auto-translate the top ~260 missing Spanish words via Google Translate API and inject them into `titles.json`.

## 3. Why the User is Frustrated
The user is highly dissatisfied with the dictionary approach. Even with 260 words auto-populated, the user noticed Spanglish titles (e.g., `"Keychain Escudo Hogwarts Harry Potter 6cm"` because "Escudo" was missing). 
The user wants a system that is **100% automated and future-proof** for hundreds/thousands of diverse words, without requiring them to manually curate a JSON dictionary or run extraction scripts.

**Claude, your immediate challenge is:**
How do you achieve 100% translation coverage for 30k products dynamically, without hitting rate limits, breaking the bank on DeepL/OpenAI, or causing the import stream to stall? 

*Hint: There is a `translateTextCached` function in `lib/importer/transform/translate.js` that supports DeepL and LibreTranslate, but it might need to be optimized or enabled for titles if the user wants true API-based translation. Currently, titles bypass the API and strictly use the glossary.*

## 4. Key Files to Investigate
- `lib/importer/transform/translate.js` (Main translation router for products)
- `lib/importer/transform/glossary/translateTitle.js` (The current dictionary-based title translator)
- `lib/importer/transform/glossary/titles.json` (The dictionary itself)
- `lib/importer/transform/glossary/categories.json` (The tags/categories dictionary)
- `lib/importer/connectors/ociostock/csvFieldMap.js` (Where CSV fields map to internal DB fields)

## 5. Deployment
- The app is deployed on Fly.io.
- Command to deploy: `npm run build && /Users/carlosrebelo/.fly/bin/fly deploy`
- Ensure you commit code to `main` before deploying.

Good luck!
