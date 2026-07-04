'use strict';
// Jednorázové doplnění odkazů na Disk (drive_url) k naimportovaným smlouvám.
// URL vytažené z hypertextových odkazů registru (sloupec „Odkaz na Disk"),
// mapované 1:1 po číslech smluv (ověřeno). Spouští se 1× (meta guard).

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_drive_urls_v1';

const URLS = {
  '2026-017': 'https://drive.google.com/file/d/1OE1rmLEAs17zqRbNit2VqOeO3jfXUgVf/view',
  '2025-004': 'https://drive.google.com/file/d/1sMLNjsKsuRP-Ye_2BN6L9NBrWg-ePbc3/view',
  '2026-014': 'https://drive.google.com/file/d/1MNKV_bgEV88OytK1sPbOfZmfFKvJz34F/view',
  '2026-006': 'https://drive.google.com/file/d/1Y_ySuKOmp8r-Gfbz5BPSv5tWUN41ys1v/view',
  '2026-001': 'https://drive.google.com/file/d/12MMfujq1xeBLYkzfydVTr3oAQ8oMF16L/view',
  '2026-008': 'https://drive.google.com/file/d/1nDAvfDGAdzlDdUB4HWF5bbchBPR2lWek/view',
  '2026-002': 'https://drive.google.com/file/d/1u732p0iEMt46_AEciyj2B9Jyid8cm3KQ/view',
  '2026-003': 'https://drive.google.com/file/d/1SV4df65tKgJqxy0lG-OFsnjXHHvqnQ4h/view',
  '2026-004': 'https://drive.google.com/file/d/1R3o9w57HE1RPvjDQgyNmbOC2JSLf3TSI/view',
  '2026-009': 'https://drive.google.com/file/d/1ByxWzch-Nmui-rvVCF6rhu2XdhhcLW8D/view',
  '2025-008': 'https://drive.google.com/drive/folders/19LQRDsCfhif3NteCGOK7w6ISCWeoLYzG',
  '2025-009': 'https://drive.google.com/file/d/1t0F81p3n88OFj8vZjZEnxaB7Bo6H85i-/view',
  '2026-010': 'https://drive.google.com/file/d/12wnL8hgtpoOStEV8zHhnfnJ9ryS5rLi1/view',
  '2025-001': 'https://drive.google.com/file/d/13WkFsdnaWTEz3g7hEgMAI7ttfnUju4kf/view',
  '2026-007': 'https://drive.google.com/file/d/1vlEMwO6ii8S89cdzWwdhyihlziZGN3Se/view',
  '2026-005': 'https://drive.google.com/file/d/1f5K69l-5FQ-KtJ9E9uhoDGn2Y-K4HlQv/view',
  '2026-013': 'https://drive.google.com/file/d/1diI5KYFKOQGA9PJRpO031Q2_KCbDB04H/view',
  '2025-010': 'https://drive.google.com/file/d/1mfB0dFexyvEl2vkuOmeGXMfHyMTaqn7J/view',
  '2026-016': 'https://drive.google.com/file/d/10DaTzWZVj8RochUFhC6Yk5jcaTmbsWqY/view',
  '2026-011': 'https://drive.google.com/file/d/1suqE_T1V_KxSvrg5VBgtv6RsgCVkJOkV/view',
  '2026-012': 'https://drive.google.com/drive/folders/114kaub4Li8KadPbPKQ154owWwhfFxOmP',
  '2026-015': 'https://drive.google.com/file/d/1VoJOzJEG-sMgOg4-cVn6tHVnbxS5yvvM/view',
  '2025-005': 'https://drive.google.com/file/d/1PTv_azkl23DMQvM47R5xIbOV0YjAfMKE/view',
  '2025-011': 'https://drive.google.com/file/d/1QStHLyibf9XO10XgWG-nAKyCmF4MD4TG/view',
  'KS-2026': 'https://drive.google.com/drive/folders/1sroGrLBbW3Hse7z8Hdr5OyIOMI5oTdT9',
  'KS-2025': 'https://drive.google.com/drive/folders/1XVtNyC9vyRiz_uqYRewteDawlzIRDsyN',
};

function seedDriveUrls(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const [cislo, url] of Object.entries(URLS)) {
    const s = M.smlouva.getByCislo(cislo);
    if (s) { M.smlouva.update(s.id, { drive_url: url }, 'seed-urls'); n++; }
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed drive_url: aktualizováno ${n}/${Object.keys(URLS).length} smluv`);
  return { aktualizovano: n };
}

module.exports = { seedDriveUrls, URLS, SEED_KEY };
