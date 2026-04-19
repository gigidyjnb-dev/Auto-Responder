# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js Express application for automated marketplace replies.

- **`src/server.js`**: Main entry point and API route definitions.
- **`src/db.js`**: SQLite database interface using `better-sqlite3`.
- **`src/responseEngine.js`**: Core logic for reply generation (OpenAI or fallback).
- **`src/riskRules.js`**: Risk and confidence scoring for inbound messages.
- **`src/setup.js`**: Interactive CLI configuration wizard.
- **`public/`**: Frontend web panels (Main App, Admin Queue).
- **`scripts/`**: Build utilities for the browser extension and database maintenance.
- **`connectors/`**: Starter templates for third-party automation bridges (Zapier, Make, n8n).

## Build, Test, and Development Commands

- **`npm run dev`**: Start the development server with `nodemon`.
- **`npm run setup`**: Run the interactive configuration wizard to generate `.env`.
- **`npm test`**: Execute the test suite using the Node.js native test runner.
- **`npm run build:ext`**: Package the browser extension into a ZIP file.
- **`npm run db:backup`** / **`npm run db:restore`**: Database maintenance utilities.

## Coding Style & Naming Conventions

- **Module System**: Uses **CommonJS** (`require`/`module.exports`).
- **Standard**: Follows standard Node.js/Express patterns. No external linter is enforced, but code should remain consistent with existing files.
- **Environment**: Configuration is managed via `.env` files using `dotenv`.

## Testing Guidelines

- **Framework**: Uses the native Node.js test runner (`node --test`).
- **API Testing**: Uses `supertest` for integration tests.
- **Run single test**: `node --test tests/api.test.js`

## Commit & Pull Request Guidelines

- **Message Format**: Use descriptive, imperative-style commit messages (e.g., "Add validation...", "Fix extension...").
- **Prefixes**: Use platform-specific prefixes when applicable (e.g., "Railway: ...").
- **Quality**: Ensure all tests pass (`npm test`) before committing.
