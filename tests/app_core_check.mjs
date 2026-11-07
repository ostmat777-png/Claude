// Проверка ядра телефонной версии (app/core.js) без сети:  node tests/app_core_check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// core.js — ES-модуль браузера; для Node копируем его как .mjs
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zab-')), 'core.mjs');
fs.copyFileSync(path.join(here, '..', 'app', 'core.js'), tmp);
const core = await import(pathToFileURL(tmp));

// правила тегов
assert.equal(core.lifecycleStrength({ building: 'yes', 'disused:shop': 'car_parts' })[0], 0);
assert.ok(!core.isLifecycle({ 'was:building': 'yes' }));
assert.ok(!core.isLifecycle({ abandoned: 'yes', amenity: 'fountain' }));
assert.ok(core.lifecycleStrength({ 'disused:amenity': 'school', building: 'school' })[0] >= 2.2);
assert.ok(core.lifecycleStrength({ building: 'ruins' })[0] >= 3);
assert.ok(core.isConstruction({ landuse: 'brownfield', name: 'Строительство ЖК «Ратуша»' }));
assert.ok(!core.isLifecycle({ landuse: 'brownfield', name: 'Строительство ЖК «Ратуша»' }));

// маленький «город»: руина в лесу, заброшенный дом в парке, жилой дом с закрытым магазином, 2 руины рядом (территория)
const sq = (id, lon, lat, d, tags) => ({ type: 'way', id, tags, geometry: [[lon, lat], [lon + d, lat], [lon + d, lat + d / 2], [lon, lat + d / 2], [lon, lat]].map(([x, y]) => ({ lon: x, lat: y })) });
const els = [
  sq(1, 28.70, 60.70, 0.0003, { building: 'ruins' }),
  sq(2, 28.75, 60.71, 0.0003, { building: 'yes', abandoned: 'yes' }),
  sq(3, 28.749, 60.709, 0.004, { leisure: 'park', name: 'Парк' }),
  sq(4, 28.72, 60.72, 0.0003, { building: 'apartments' }),
  { type: 'node', id: 5, lat: 60.72005, lon: 28.72015, tags: { 'disused:shop': 'grocery' } },
  sq(6, 28.73, 60.73, 0.0002, { building: 'yes', ruins: 'yes' }),
  sq(7, 28.7304, 60.7301, 0.0002, { building: 'yes', ruins: 'yes' }),
];
const area = { type: 'Polygon', rings: [[[28.69, 60.69], [28.77, 60.69], [28.77, 60.74], [28.69, 60.74], [28.69, 60.69]]] };
const res = await core.search(area, { elements: els });
const by = (k) => res.cands.find((c) => c.key === k);
assert.ok(by('osm:way/1').f.reliable, 'руина в лесу — надёжная');
assert.ok(!by('osm:way/2').f.reliable && by('osm:way/2').f.contra.length, 'заброшенный дом в парке — противоречие');
assert.ok(!by('osm:way/4') || !by('osm:way/4').f.reliable, 'закрытый магазин не делает дом заброшкой');
const cx = res.cands.find((c) => c.kind === 'complex');
assert.ok(cx && cx.f.n_members === 2 && cx.f.reliable, 'две руины рядом — одна территория');
assert.ok(by('osm:way/6').f.complex_key === cx.key);
const plain = core.toPlain(cx);
assert.equal(plain.footprint.type, 'Polygon');
console.log('app core: ok', JSON.stringify(res.stats));
