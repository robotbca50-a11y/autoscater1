const APP = {
  NAME: 'AUTO CEK SCATER LIVE (GLOBAL)',
  VERSION: '1.6.0',
  PARALLEL_LIMIT: 20,
  PROCESS_TIMEOUT_MS: 90000,
  BONUS_PROCESS_TIMEOUT_MS: 60000,
  BONUS_PARALLEL_LIMIT: 1,
  HISTORY_TOKEN_TTL_MS: 55 * 60 * 1000,
  SNIFFER_ACTIVE_TTL_MS: 2 * 60 * 60 * 1000,
  SMB_SCAN_INTERVAL_MS: 60000,
  MAX_WORKERS: 20,
  MAX_TICKETS_DB: 2500
};

const URLS = {
  APPS_SCRIPT: 'https://script.google.com/macros/s/AKfycbwYQ_rASFhduaTDaPQWNDoN6WbEX0dIqBkTCpdJRvGOWY0y9cfSEQ70ITIpiMEjguDb/exec',
  GAS: 'https://script.google.com/macros/s/AKfycbwYQ_rASFhduaTDaPQWNDoN6WbEX0dIqBkTCpdJRvGOWY0y9cfSEQ70ITIpiMEjguDb/exec',
  TICKETS: 'https://bonussmb.com/tickets?page=1&limit=500',
  HISTORY_API: 'https://public-api.zmcyu9ypy.com/web-api/operator-proxy/v1/History/GetBetHistory'
};

const TICKETS_TAB_URLS = ['*://bonussmb.com/tickets*', '*://www.bonussmb.com/tickets*'];

const DEFAULT_SCATTER_RULES = [
  { id: 1, minBet: 1600,  maxBet: 2000,    hadiah: { 3: 15000,  4: 30000,  5: 75000  } },
  { id: 2, minBet: 4000,  maxBet: 8000,    hadiah: { 3: 35000,  4: 70000,  5: 140000 } },
  { id: 3, minBet: 10000, maxBet: 18000,   hadiah: { 3: 50000,  4: 100000, 5: 200000 } },
  { id: 4, minBet: 20000, maxBet: 1000000, hadiah: { 3: 100000, 4: 200000, 5: 400000 } }
];

const SNIFFER_HEADERS = ['x-access-token', 'x-agent-token', 'authorization', 'x-token', 'x-api-key', 'token'];

const THEME_CONFIG = {
  monster:    { cls: 'theme-abyss',      video: 'https://www.image2url.com/r2/default/videos/1787800848892-8b74acdb-0012-4d0a-a4af-124c427603ca.mp4',          portrait: false, opacity: 1.0, brightness: 1.15 },
  aurora:     { cls: 'theme-aurora',     video: 'https://www.image2url.com/r2/default/videos/1787800882683-6642a9e3-8107-47b9-9fb7-e5dfb9bb152e.mp4',          portrait: false, opacity: 1.0, brightness: 1.1  },
  galaxy:     { cls: 'theme-galaxy',     video: 'https://www.image2url.com/r2/default/videos/1787800945740-b688706f-5e44-4d6c-8699-6bd78f3e1003.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  matrix:     { cls: 'theme-toxic',      video: 'https://www.image2url.com/r2/default/videos/1787800939858-cf5afa4f-a7f5-4f7e-8451-3170947d5ad9.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  nextnft:    { cls: 'theme-voidtheme',  video: 'https://www.image2url.com/r2/default/videos/1787800988614-f6c8300b-e5b1-474a-b689-55e566e25146.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  cyberroom:  { cls: 'theme-cyberroom',  video: 'https://www.image2url.com/r2/default/videos/1787801013209-8070bdb3-0740-4c15-8a41-e29f5f2c032d.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  angel:      { cls: 'theme-snownight',  video: 'https://www.image2url.com/r2/default/videos/1787801052053-38cfe2f9-1b63-41dd-a74e-0dcaeb35b2e2.mp4',          portrait: false, opacity: 1.0, brightness: 1.1  },
  girlstudy:  { cls: 'theme-lavender',   video: 'https://www.image2url.com/r2/default/videos/1787801068929-93202e1d-11eb-48a5-b095-d62423a4ce22.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  spacecraft: { cls: 'theme-frostbite',  video: 'https://www.image2url.com/r2/default/videos/1787801167590-c4b6dfff-b863-4e5d-ad48-eb756bdbbeae.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  pesawahan:  { cls: 'theme-stone',      video: 'https://www.image2url.com/r2/default/videos/1787801215410-0f2f69bc-ff8b-465b-96a4-498501cc3470.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  robot:      { cls: 'theme-darkknight', video: 'https://www.image2url.com/r2/default/videos/1787801211674-124eb026-b5cb-4cae-9fcc-83daca7f8068.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  hacker:     { cls: 'theme-nightride',  video: 'https://www.image2url.com/r2/default/videos/1787801201497-4eea5a70-841c-409a-ba69-636712bd53bf.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  pintubumi:  { cls: 'theme-hellgate',   video: 'https://www.image2url.com/r2/default/videos/1787801207563-fe8838a6-d43b-4c98-8dbe-1c7975370ba9.mp4',          portrait: false, opacity: 1.0, brightness: 1.1,  contain: true },
  iblis:      { cls: 'theme-inferno',    video: 'https://www.image2url.com/r2/default/videos/1787801364719-2f559a28-f8ce-45e6-8c6e-fc8f079c52b6.mp4',          portrait: false, opacity: 1.0, brightness: 1.1,  contain: true },
  hantucina:  { cls: 'theme-phantom',    video: 'https://www.image2url.com/r2/default/videos/1787801365339-3be48cbc-d9ee-4c4e-8ad4-8fa7523e8aa6.mp4',          portrait: false, opacity: 1.0, brightness: 1.1,  contain: true },
  lofi:       { cls: 'theme-lofi',       video: 'videos/lofi.mp4',                                                                                            portrait: false, opacity: 1.0, brightness: 1.0  },
  yakuza:     { cls: 'theme-ember',      video: 'https://www.image2url.com/r2/default/videos/1787801369257-fc6aa301-c93a-48e4-95a2-9ef76fa19c35.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  engkol:     { cls: 'theme-coral',      video: 'https://www.image2url.com/r2/default/videos/1787801363750-06a6034d-4ef5-4a9c-be58-022b63a81eca.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  matahari:   { cls: 'theme-solaris',    video: 'https://www.image2url.com/r2/default/videos/1787801619063-02fb5ea9-c5f0-413b-9437-1c594c042372.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  galau:      { cls: 'theme-nebula',     video: 'https://www.image2url.com/r2/default/videos/1787801615581-10de6ea2-a335-47c5-9432-2e0077434e8e.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  trainsad:   { cls: 'theme-slate',      video: 'https://www.image2url.com/r2/default/videos/1787801617242-a3355934-9b84-48c3-bfdf-0432b0e9f01c.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  pulau:      { cls: 'theme-mint',       video: 'https://www.image2url.com/r2/default/videos/1787801615961-e9514cc5-ad37-4ffe-9b75-64ab3c9c51b8.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  purpleaura: { cls: 'theme-polaris',    video: 'https://www.image2url.com/r2/default/videos/1787801619752-e664cdf3-16c4-4c5d-b19b-0c4dea502721.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  anime:      { cls: 'theme-sakura',     video: 'https://www.image2url.com/r2/default/videos/1787802051626-3e143c85-5e25-4f5a-b2ec-8b0de094ea2e.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  chinagirl:  { cls: 'theme-crimson',    video: 'https://www.image2url.com/r2/default/videos/1787802051754-36b9c293-bd7a-4cd2-88b6-042434fbd6d9.mp4',          portrait: false, opacity: 1.0, brightness: 0.85, contain: true },
  cucidmata:  { cls: 'theme-emerald',    video: 'https://www.image2url.com/r2/default/videos/1787802060094-357a3076-ca23-4cd0-bd5d-8a28e6405bec.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  castil:     { cls: 'theme-burgundy',   video: 'https://www.image2url.com/r2/default/videos/1787802058373-ca60ca5f-98c9-4c25-89b7-5477920a7793.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  luffy:      { cls: 'theme-cosmos',     video: 'https://www.image2url.com/r2/default/videos/1787802124654-1667554c-3478-4959-87ab-e05d3f539da7.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  chinaanime: { cls: 'theme-olive',      video: 'https://www.image2url.com/r2/default/videos/1787802126361-6d3feeb7-d645-47c0-8c9d-5337f1e21eeb.mp4',          portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  bunga:      { cls: 'theme-rosewood',   video: 'https://i.imgur.com/lzDyawu.mp4',                                                                            portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  hutan:      { cls: 'theme-forest',     video: 'https://i.imgur.com/HkJqfdK.mp4',                                                                            portrait: false, opacity: 1.0, brightness: 1.05, contain: true },
  kode:       { cls: 'theme-obsidian',   video: 'https://i.imgur.com/TDQEgvU.mp4',                                                                            portrait: false, opacity: 1.0, brightness: 1.05, contain: true }
};
const DEFAULT_THEME = 'monster';
const ALL_THEME_CLASSES = Object.values(THEME_CONFIG).map(c => c.cls);

const DEFAULT_OPERATOR_LINE = 'bandar80';
const DEFAULT_RULES_PIN = '9090';

const KLAIM_STRUCTURAL_NOISE = new Set([
  'situs', 'user id', 'userid', 'total klaim', 'tipe game',
  'kode tiket', 'betting', 'scatter', 'hadiah', 'klaim',
  'bukti screenshot', 'status'
]);
const KLAIM_GAME_NAME_PATTERN = /^(mahjong(\s*\d+|\s*wd)?|slot\s|pg\s|pragmatic)/i;
