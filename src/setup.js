#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '..', '.env');
const EXAMPLE_PATH = path.join(__dirname, '..', '.env.example');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

function print(text = '') {
  process.stdout.write(text + '\n');
}

function bold(text) {
  return `${BOLD}${text}${RESET}`;
}

function green(text) {
  return `${GREEN}${text}${RESET}`;
}

function cyan(text) {
  return `${CYAN}${text}${RESET}`;
}

function yellow(text) {
  return `${YELLOW}${text}${RESET}`;
}

function dim(text) {
  return `${DIM}${text}${RESET}`;
}

function ask(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const hint = defaultValue ? dim(` [${defaultValue}]`) : '';
    rl.question(`${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askYesNo(rl, question, defaultYes = true) {
  return new Promise((resolve) => {
    const hint = defaultYes ? dim(' [Y/n]') : dim(' [y/N]');
    rl.question(`${question}${hint}: `, (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) {
        resolve(defaultYes);
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
  });
}

function loadExistingEnv() {
  const existing = {};
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        existing[match[1]] = match[2];
      }
    }
  }
  return existing;
}

function writeEnv(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
}

async function run() {
  print();
  print(bold('  Marketplace Auto-Responder — Setup Wizard'));
  print(dim('  This will create your .env configuration file.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const existing = loadExistingEnv();
  const config = { ...existing };

  const isUpdate = fs.existsSync(ENV_PATH);
  if (isUpdate) {
    print(yellow('  Existing .env detected. Only values you change will be updated.\n'));
  }

  print(cyan('  — Basic Settings ——————————————————'));
  config.PORT = await ask(rl, '  Port to run the server on', existing.PORT || '3000');

  print();
  print(cyan('  — AI Responses (Optional) —————————'));
  print(dim('  Leave blank to use built-in response logic instead.\n'));
  const wantsOpenAi = await askYesNo(rl, '  Do you want to use OpenAI for smarter replies?');
  if (wantsOpenAi) {
    config.OPENAI_API_KEY = await ask(rl, '  OpenAI API key', existing.OPENAI_API_KEY || '');
    config.MODEL_NAME = await ask(rl, '  Model name', existing.MODEL_NAME || 'gpt-4o-mini');
  } else {
    config.OPENAI_API_KEY = '';
    config.MODEL_NAME = existing.MODEL_NAME || 'gpt-4o-mini';
  }

  print();
  print(cyan('  — Integration Security ————————————'));
  print(dim('  Needed for connecting eBay, Etsy, Craigslist, etc.\n'));
  const hasKey = existing.INTEGRATION_API_KEY;
  if (hasKey) {
    const changeKey = await askYesNo(rl, '  Integration API key already set. Change it?', false);
    if (changeKey) {
      config.INTEGRATION_API_KEY = await ask(rl, '  New integration API key', '');
    }
  } else {
    config.INTEGRATION_API_KEY = await ask(rl, '  Choose an integration API key (shared secret)', '');
  }

  print();
  print(cyan('  — Admin Security (Recommended) —————'));
  print(dim('  Protects /admin queue actions with a login password.\n'));
  const wantsAdminPassword = await askYesNo(rl, '  Require admin login for queue approvals?', true);
  if (wantsAdminPassword) {
    config.ADMIN_PASSWORD = await ask(rl, '  Admin password', existing.ADMIN_PASSWORD || '');
    config.ADMIN_SESSION_SECRET = await ask(
      rl,
      '  Admin session secret (leave blank to auto-generate each restart)',
      existing.ADMIN_SESSION_SECRET || ''
    );
    config.ADMIN_SESSION_TTL_HOURS = await ask(
      rl,
      '  Admin session lifetime in hours',
      existing.ADMIN_SESSION_TTL_HOURS || '12'
    );
  } else {
    config.ADMIN_PASSWORD = existing.ADMIN_PASSWORD || '';
    config.ADMIN_SESSION_SECRET = existing.ADMIN_SESSION_SECRET || '';
    config.ADMIN_SESSION_TTL_HOURS = existing.ADMIN_SESSION_TTL_HOURS || '12';
  }

  print();
  print(cyan('  — Auto-Send Behavior ——————————————'));
  config.AUTO_SEND_ENABLED = (await askYesNo(rl, '  Auto-send high-confidence replies?')) ? 'true' : 'false';
  config.AUTO_SEND_MIN_CONFIDENCE = await ask(rl, '  Min confidence to auto-send (0–1)', existing.AUTO_SEND_MIN_CONFIDENCE || '0.72');
  config.OFFER_FLOOR_RATIO = await ask(rl, '  Flag offers below this ratio of list price (e.g. 0.75 = 75%)', existing.OFFER_FLOOR_RATIO || '0.75');

  print();
  print(cyan('  — Facebook Messenger (Optional) ———'));
  print(dim('  Skip this if you are not using Messenger yet.\n'));
  const wantsFb = await askYesNo(rl, '  Add Facebook Messenger credentials?', false);
  if (wantsFb) {
    config.FB_PAGE_ACCESS_TOKEN = await ask(rl, '  Page access token', existing.FB_PAGE_ACCESS_TOKEN || '');
    config.FB_VERIFY_TOKEN = await ask(rl, '  Verify token (any string you choose)', existing.FB_VERIFY_TOKEN || '');
    config.FB_GRAPH_VERSION = await ask(rl, '  Graph API version', existing.FB_GRAPH_VERSION || 'v22.0');
  } else {
    config.FB_PAGE_ACCESS_TOKEN = existing.FB_PAGE_ACCESS_TOKEN || '';
    config.FB_VERIFY_TOKEN = existing.FB_VERIFY_TOKEN || '';
    config.FB_GRAPH_VERSION = existing.FB_GRAPH_VERSION || 'v22.0';
  }

  print();
  print(cyan('  — Outbound Bridge (Optional) ——————'));
  print(dim('  Where approved replies are sent for non-Messenger channels.\n'));
  const wantsBridge = await askYesNo(rl, '  Add outbound bridge webhook URL?', false);
  if (wantsBridge) {
    config.OUTBOUND_BRIDGE_URL = await ask(rl, '  Outbound bridge URL', existing.OUTBOUND_BRIDGE_URL || '');
    config.OUTBOUND_BRIDGE_KEY = await ask(rl, '  Outbound bridge key (optional)', existing.OUTBOUND_BRIDGE_KEY || '');
  } else {
    config.OUTBOUND_BRIDGE_URL = existing.OUTBOUND_BRIDGE_URL || '';
    config.OUTBOUND_BRIDGE_KEY = existing.OUTBOUND_BRIDGE_KEY || '';
  }

  config.SCAM_KEYWORDS = existing.SCAM_KEYWORDS || 'code,verification,zelle only,wire transfer,cashier check,ship to my cousin';
  config.ADMIN_LOGIN_RATE_WINDOW_MS = existing.ADMIN_LOGIN_RATE_WINDOW_MS || '600000';
  config.ADMIN_LOGIN_RATE_MAX = existing.ADMIN_LOGIN_RATE_MAX || '20';
  config.INTEGRATION_RATE_WINDOW_MS = existing.INTEGRATION_RATE_WINDOW_MS || '60000';
  config.INTEGRATION_RATE_MAX = existing.INTEGRATION_RATE_MAX || '180';
  config.OUTBOUND_RETRY_ATTEMPTS = existing.OUTBOUND_RETRY_ATTEMPTS || '3';
  config.OUTBOUND_RETRY_DELAY_MS = existing.OUTBOUND_RETRY_DELAY_MS || '250';

  rl.close();

  writeEnv(config);

  print();
  print(green('  ✓ .env saved successfully!'));
  print();
  print(bold('  Next steps:'));
  print(`  1. Run ${cyan('npm run dev')} to start the server`);
  print(`  2. Open ${cyan(`http://localhost:${config.PORT}`)} to test replies`);
  if (!config.OPENAI_API_KEY) {
    print(`  3. ${yellow('Tip:')} Add an OPENAI_API_KEY later for smarter AI responses`);
  }
  print();
}

run().catch((err) => {
  process.stderr.write(`Setup failed: ${err.message}\n`);
  process.exit(1);
});
