/* ============================================================================
   Generates a realistic squad CSV for load-testing and demos.

     node tools/make-fixture.mjs [swimmers] [outfile]

   Defaults to 150 swimmers — the size the app must handle without crashing.
   The output deliberately includes the messy cases that broke the old build:
   a swimmer with no gender, names with apostrophes and commas, a DQ, a blank
   time, a duplicated row and a CRLF line ending.
============================================================================ */

import { writeFileSync } from 'node:fs';

const count = parseInt(process.argv[2], 10) || 150;
const outfile = process.argv[3] || 'tests/fixtures/squad-150.csv';

const FIRST = ['Ava','Mia','Zoe','Ella','Ruby','Chloe','Grace','Lily','Isla','Sienna',
  'Noah','Jack','Liam','Ethan','Lucas','Mason','Leo','Kai','Hugo','Max',
  'Amelia','Harper','Willow','Freya','Ivy','Oliver','Archie','Finn','Beau','Elias'];
const LAST = ["O'Brien",'Nguyen','Smith','Zhang','Patel','Kowalski','Silva','Müller',
  'Anderson','Tran','Okafor','Rossi','Dubois','Kim','Haddad','Novak','Reyes','Walsh',
  'Fitzgerald','Yamamoto'];
const CLUBS = ['Artemis Aquatics','Northside Swim Club','Harbour City','Riverbend SC',
  'Blue Water Aquatic','Meridian Swimming'];
const MEETS = ['State Age Championships','Winter Short Course','Metro Qualifier',
  'National Age Championships','Club Championships','Regional Sprint Meet','Summer Open'];

const EVENTS = [
  { d: 50,  s: 'Freestyle',    base: 30 },
  { d: 100, s: 'Freestyle',    base: 66 },
  { d: 200, s: 'Freestyle',    base: 143 },
  { d: 400, s: 'Freestyle',    base: 300 },
  { d: 50,  s: 'Backstroke',   base: 35 },
  { d: 100, s: 'Backstroke',   base: 75 },
  { d: 200, s: 'Backstroke',   base: 160 },
  { d: 50,  s: 'Breaststroke', base: 39 },
  { d: 100, s: 'Breaststroke', base: 84 },
  { d: 200, s: 'Breaststroke', base: 180 },
  { d: 50,  s: 'Butterfly',    base: 33 },
  { d: 100, s: 'Butterfly',    base: 72 },
  { d: 200, s: 'Medley',       base: 165 },
  { d: 400, s: 'Medley',       base: 350 }
];

// Deterministic PRNG so the fixture is byte-identical run to run — a test
// that changes its own input is not a test.
let seed = 20260401;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

function fmt(sec) {
  if (sec < 60) return sec.toFixed(2);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
}

const rows = [];
const usedNames = new Set();

for (let i = 0; i < count; i++) {
  let name;
  let guard = 0;
  do {
    name = `${pick(FIRST)} ${pick(LAST)}`;
    guard++;
  } while (usedNames.has(name) && guard < 60);
  if (usedNames.has(name)) name = `${name} ${i}`;
  usedNames.add(name);

  const club = pick(CLUBS);
  const gender = i % 2 === 0 ? 'Female' : 'Male';
  const startAge = 10 + Math.floor(rnd() * 6);
  const talent = 0.82 + rnd() * 0.3;          // faster swimmers have a lower factor
  const events = EVENTS.filter(() => rnd() < 0.45);
  if (!events.length) events.push(EVENTS[0]);

  for (let y = 0; y < 4 + Math.floor(rnd() * 3); y++) {
    const year = 2022 + y;
    const age = startAge + y;
    if (age > 18) continue;
    // Younger swimmers improve fastest; gains taper with age.
    const ageFactor = 1 + (17 - age) * 0.026;

    for (const ev of events) {
      const meets = 1 + Math.floor(rnd() * 3);
      for (let m = 0; m < meets; m++) {
        const course = rnd() < 0.6 ? 'LC' : 'SC';
        const courseAdj = course === 'SC' ? 0.982 : 1;
        const noise = 0.985 + rnd() * 0.035;
        const genderAdj = gender === 'Male' ? 0.945 : 1;
        const secs = ev.base * talent * ageFactor * courseAdj * noise * genderAdj;
        const month = 1 + Math.floor(rnd() * 12);
        const day = 1 + Math.floor(rnd() * 28);
        rows.push({
          name,
          gender,
          club,
          course,
          distance: ev.d + 'M',
          stroke: ev.s,
          time: fmt(secs),
          race_date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          age_grp: `${age}y/o`,
          race_name: `${year} ${pick(MEETS)}`
        });
      }
    }
  }
}

// ── Deliberately messy rows, so the tests exercise the real failure modes ──
const messy = [
  // No gender: must appear in tables but never in a points chart.
  { name: 'Unknown Gender', gender: '', club: 'Artemis Aquatics', course: 'LC',
    distance: '100M', stroke: 'Freestyle', time: '1:12.40', race_date: '2025-06-14',
    age_grp: '14y/o', race_name: '2025 Club Championships' },
  // A comma and a quote in a name, and a comma in the meet name.
  { name: 'Smith, Jordan "JJ"', gender: 'Male', club: 'Riverbend SC', course: 'SC',
    distance: '50M', stroke: 'Butterfly', time: '28.90', race_date: '2025-08-02',
    age_grp: '16y/o', race_name: 'Winter Open, Session 3' },
  // Markup in a name: must be escaped, never executed.
  { name: '<script>alert(1)</script>', gender: 'Female', club: 'Northside Swim Club',
    course: 'LC', distance: '100M', stroke: 'Backstroke', time: '1:15.00',
    race_date: '2025-05-05', age_grp: '15y/o', race_name: '2025 Metro Qualifier' },
  // Unusable rows: must be skipped, not crash the parser.
  { name: 'Bad Row', gender: 'Male', club: 'X', course: 'LC', distance: '100M',
    stroke: 'Freestyle', time: 'DQ', race_date: '2025-01-01', age_grp: '', race_name: 'Meet' },
  { name: 'Bad Row', gender: 'Male', club: 'X', course: 'LC', distance: '100M',
    stroke: 'Freestyle', time: '', race_date: '2025-01-01', age_grp: '', race_name: 'Meet' },
  { name: '', gender: 'Male', club: 'X', course: 'LC', distance: '100M',
    stroke: 'Freestyle', time: '1:00.00', race_date: '2025-01-01', age_grp: '', race_name: 'Meet' }
];
rows.push(...messy);
// An exact duplicate of a real row: must be deduplicated on import.
rows.push({ ...rows[0] });

const COLS = ['name','gender','club','course','distance','stroke','time','race_date','age_grp','race_name'];
const esc = v => /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = [COLS.join(',')]
  .concat(rows.map(r => COLS.map(c => esc(r[c] ?? '')).join(',')))
  .join('\r\n') + '\r\n';   // CRLF on purpose — this is what Excel writes

writeFileSync(outfile, csv, 'utf8');
console.log(`${outfile}: ${count} swimmers, ${rows.length} rows, ${(csv.length / 1024).toFixed(0)} KB`);
