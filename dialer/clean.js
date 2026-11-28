// Lead data hygiene for the Cold Call Dialer. Used on import (parse.js) and as a
// one-time/idempotent pass over leads already stored.
//
//   - strips the old "HOLD - NOT APPROVED" / "source-use review required" flags
//   - one spelling per city ("Saint Louis", "ST Louis", "ST. Louis" -> "St. Louis")
//   - one spelling per owner category ("BLACK", "Black/African American" -> one value)
//   - fills a blank County where it can be worked out safely

// ---- Old review flags ---------------------------------------------------------------
const FLAG_RE = /HOLD\s*[-–—]?\s*NOT\s*APPROVED|source[-\s]*use\s*review(?:\s*required)?/gi;
const FLAG_TEST = /HOLD\s*[-–—]?\s*NOT\s*APPROVED|source[-\s]*use\s*review/i;
const FLAG_KEY = /^(outreach[\s_-]*status|source[\s_-]*use([\s_-]*(review|status|flag))?|approval([\s_-]*status)?|review[\s_-]*flag)$/i;

// Removes the flag text from one string. Returns '' when nothing meaningful is left.
function scrubFlagText(value) {
  const s = String(value);
  if (!FLAG_TEST.test(s)) return s;
  return s.replace(FLAG_RE, ' ').replace(/\s*[;,|/]\s*(?=[;,|/]|$)/g, ' ').replace(/^[\s;,|/-]+|[\s;,|/-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Mutates the lead. Returns true when something was removed.
function stripFlags(lead) {
  let changed = false;
  const extra = lead.extra;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      const text = String(v == null ? '' : v);
      if (FLAG_TEST.test(text) || (FLAG_KEY.test(k.trim()) && /hold|not approved|review required/i.test(text))) {
        const left = FLAG_KEY.test(k.trim()) ? '' : scrubFlagText(text);
        if (left) extra[k] = left; else delete extra[k];
        changed = true;
      } else if (FLAG_TEST.test(k)) { delete extra[k]; changed = true; }
    }
  }
  for (const k of ['outreachStatus', 'sourceUse', 'sourceUseReview', 'holdStatus']) {
    if (lead[k] !== undefined) { delete lead[k]; changed = true; }
  }
  for (const [k, v] of Object.entries(lead)) {
    if (typeof v === 'string' && FLAG_TEST.test(v)) {
      const left = scrubFlagText(v);
      lead[k] = left;
      changed = true;
    }
  }
  return changed;
}

// ---- Cities and counties ------------------------------------------------------------
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'\-.(\/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// "Saint Louis" / "St Louis" / "ST. Louis" / "ST LOUIS" -> "St. Louis". Never touches "Stanton".
function normalizeCity(city) {
  let c = String(city == null ? '' : city).replace(/\s+/g, ' ').trim();
  if (!c) return '';
  c = c.replace(/,\s*[A-Za-z]{2}\.?$/, '').trim();                 // "St. Louis, MO"
  if (!/[a-z]/.test(c) || !/[A-Z]/.test(c)) c = titleCase(c);        // ALL CAPS / all lower -> Title Case
  c = c.replace(/^(saint|st)(\.\s*|\s+)(?=\S)/i, 'St. ').replace(/^(sainte|ste)(\.\s*|\s+)(?=\S)/i, 'Ste. ');
  c = c.replace(/\s(saint|st)(\.\s*|\s+)(?=\S)/gi, ' St. ');        // "Town of St Charles"
  return c.trim();
}

function normalizeCounty(county) {
  let c = String(county == null ? '' : county).replace(/\s+/g, ' ').trim().replace(/\s+county$/i, '');
  if (!c) return '';
  if (!/[a-z]/.test(c) || !/[A-Z]/.test(c)) c = titleCase(c);
  if (/^(saint|st\.?)\s+louis\s+city$/i.test(c) || /^city of (saint|st\.?)\s+louis$/i.test(c)) return 'St. Louis City';
  return normalizeCity(c);
}

// ---- Owner fields ----------------------------------------------------------------------
function normalizeOwnerEthnicity(v) {
  const raw = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const t = raw.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/^(black|african american|black african american|black or african american|afro american|black american)$/.test(t)) return 'Black/African American';
  if (/^(hispanic|latino|latina|latinx|hispanic latino|hispanic american|latino american|hispanic or latino)$/.test(t)) return 'Hispanic/Latino';
  if (/^(native american|american indian|alaska native|american indian alaska native|american indian or alaska native|indigenous)$/.test(t)) return 'Native American';
  if (/^(white|caucasian|white caucasian)$/.test(t)) return 'White';
  if (/^(asian|asian american)$/.test(t)) return 'Asian American';
  return /[a-z]/.test(raw) ? raw : titleCase(raw);
}

function normalizeOwnerGender(v) {
  const raw = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const t = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(f|female|woman|women)$/.test(t)) return 'Female';
  if (/^(m|male|man|men)$/.test(t)) return 'Male';
  return /[a-z]/.test(raw) ? raw : titleCase(raw);
}

// ---- County fill ------------------------------------------------------------------------
// Built-in Missouri lookups, used only when the leads themselves don't say. Cities that
// span several counties (Kansas City, St. Louis) are deliberately left to ZIP or to the
// county the other leads in that city/ZIP already carry.
const MO_CITY_COUNTY = {
  'St. Charles': 'St. Charles', "O'Fallon": 'St. Charles', 'St. Peters': 'St. Charles', Wentzville: 'St. Charles', Lake: 'St. Charles',
  Chesterfield: 'St. Louis', Florissant: 'St. Louis', Ferguson: 'St. Louis', Hazelwood: 'St. Louis', 'Maryland Heights': 'St. Louis',
  'University City': 'St. Louis', Kirkwood: 'St. Louis', 'Webster Groves': 'St. Louis', Clayton: 'St. Louis', 'Creve Coeur': 'St. Louis',
  Ballwin: 'St. Louis', Manchester: 'St. Louis', Bridgeton: 'St. Louis', Overland: 'St. Louis', Berkeley: 'St. Louis', Jennings: 'St. Louis',
  Normandy: 'St. Louis', Brentwood: 'St. Louis', Maplewood: 'St. Louis', 'Richmond Heights': 'St. Louis', Eureka: 'St. Louis', Fenton: 'St. Louis',
  Olivette: 'St. Louis', Ladue: 'St. Louis', 'Town and Country': 'St. Louis', Frontenac: 'St. Louis', 'Des Peres': 'St. Louis', Crestwood: 'St. Louis',
  'Sunset Hills': 'St. Louis', Shrewsbury: 'St. Louis', Lemay: 'St. Louis', Oakville: 'St. Louis', Mehlville: 'St. Louis', Affton: 'St. Louis',
  Dellwood: 'St. Louis', 'Black Jack': 'St. Louis', 'Bellefontaine Neighbors': 'St. Louis', 'Pine Lawn': 'St. Louis', Pagedale: 'St. Louis',
  Wellston: 'St. Louis', Northwoods: 'St. Louis', 'Velda City': 'St. Louis', 'Valley Park': 'St. Louis', Wildwood: 'St. Louis', Bellerive: 'St. Louis',
  Arnold: 'Jefferson', Festus: 'Jefferson', Imperial: 'Jefferson', Hillsboro: 'Jefferson', Barnhart: 'Jefferson', Crystal: 'Jefferson', House: 'Jefferson',
  Pacific: 'Franklin', Washington: 'Franklin', Union: 'Franklin', Sullivan: 'Franklin',
  Columbia: 'Boone', Springfield: 'Greene', 'Jefferson City': 'Cole', Independence: 'Jackson', "Lee's Summit": 'Jackson', 'Blue Springs': 'Jackson',
  Raytown: 'Jackson', Grandview: 'Jackson', Joplin: 'Jasper', 'St. Joseph': 'Buchanan', 'Cape Girardeau': 'Cape Girardeau', Rolla: 'Phelps',
  Sikeston: 'Scott', 'Poplar Bluff': 'Butler', Hannibal: 'Marion', Warrensburg: 'Johnson', Sedalia: 'Pettis', Lebanon: 'Laclede', Branson: 'Taney',
  Ozark: 'Christian', Nixa: 'Christian', Mexico: 'Audrain', Moberly: 'Randolph', Kirksville: 'Adair', Chillicothe: 'Livingston', Farmington: 'St. Francois',
  'Excelsior Springs': 'Clay', Liberty: 'Clay', Gladstone: 'Clay', 'North Kansas City': 'Clay', Smithville: 'Clay', Belton: 'Cass', Harrisonville: 'Cass',
  Raymore: 'Cass', Neosho: 'Newton', Carthage: 'Jasper', Marshall: 'Saline', Fulton: 'Callaway', Troy: 'Lincoln', Moscow: 'Pike', Bolivar: 'Polk'
};
// Cities whose names exist in several Missouri counties or are common elsewhere: skip the
// built-in table for these unless the ZIP says so (Lake, Crystal, House are partial names).
delete MO_CITY_COUNTY.Lake; delete MO_CITY_COUNTY.Crystal; delete MO_CITY_COUNTY.House;

// ZIPs that are entirely (or all but entirely) inside the City of St. Louis, and ZIPs that are
// entirely in St. Louis County. 63121 and 63139 straddle both, so they are not listed.
const STL_CITY_ZIPS = new Set(['63101', '63102', '63103', '63104', '63106', '63107', '63108', '63109', '63110', '63111', '63112', '63113', '63115', '63116', '63118', '63120', '63147']);
const STL_COUNTY_ZIPS = new Set(['63005', '63011', '63017', '63021', '63025', '63026', '63031', '63033', '63034', '63038', '63040', '63042', '63043', '63044', '63045', '63074',
  '63088', '63105', '63114', '63117', '63119', '63122', '63123', '63124', '63125', '63126', '63127', '63128', '63129', '63130', '63131', '63132', '63133', '63134', '63135',
  '63136', '63137', '63138', '63141', '63143', '63144', '63146']);

const cityKey = l => (l.state || '') + '|' + String(l.city || '').toLowerCase();
const zipKey = l => (l.state || '') + '|' + (l.zip || '');

// Learn city->county and ZIP->county from the leads that already have both. A value is used
// only when it has at least 3 examples and 90% agreement.
function buildCountyIndex(leads) {
  const tallies = { city: new Map(), zip: new Map() };
  const bump = (map, key, county) => {
    const m = map.get(key) || new Map();
    m.set(county, (m.get(county) || 0) + 1);
    map.set(key, m);
  };
  for (const l of leads) {
    if (!l.county || !l.state) continue;
    if (l.city) bump(tallies.city, cityKey(l), l.county);
    if (l.zip) bump(tallies.zip, zipKey(l), l.county);
  }
  const settle = map => {
    const out = new Map();
    for (const [key, m] of map) {
      let total = 0, best = '', bestN = 0;
      for (const [county, n] of m) { total += n; if (n > bestN) { best = county; bestN = n; } }
      if (total >= 3 && bestN / total >= 0.9) out.set(key, best);
    }
    return out;
  };
  return { city: settle(tallies.city), zip: settle(tallies.zip) };
}

function inferCounty(lead, index) {
  if (!lead.state) return '';
  if (lead.zip && index && index.zip.has(zipKey(lead))) return index.zip.get(zipKey(lead));
  if (lead.city && index && index.city.has(cityKey(lead))) return index.city.get(cityKey(lead));
  if (lead.state !== 'MO') return '';
  const city = String(lead.city || '');
  if (city === 'St. Louis' || city === '') {
    if (STL_CITY_ZIPS.has(lead.zip)) return 'St. Louis City';
    if (STL_COUNTY_ZIPS.has(lead.zip)) return 'St. Louis';
    return '';
  }
  if (MO_CITY_COUNTY[city]) return MO_CITY_COUNTY[city];
  return '';
}

// ---- One lead / all leads -----------------------------------------------------------------
function cleanLead(lead, countyIndex) {
  let changed = false;
  const set = (k, v) => { if (lead[k] !== v) { lead[k] = v; changed = true; } };
  if (stripFlags(lead)) changed = true;
  if (lead.city) set('city', normalizeCity(lead.city));
  if (lead.county) set('county', normalizeCounty(lead.county));
  if (lead.ownerEthnicity) set('ownerEthnicity', normalizeOwnerEthnicity(lead.ownerEthnicity));
  if (lead.ownerGender) set('ownerGender', normalizeOwnerGender(lead.ownerGender));
  if (!lead.county && countyIndex) {
    const c = inferCounty(lead, countyIndex);
    if (c) set('county', c);
  }
  return changed;
}

// Cleans every stored lead. Returns the leads that changed so the store can persist just those.
function cleanAll(leads) {
  const list = Array.isArray(leads) ? leads : Object.values(leads);
  const stats = { checked: list.length, changed: 0, flagsRemoved: 0, countiesFilled: 0 };
  const changed = new Set();
  // Pass 1: spelling and flags, so the county index sees one spelling per place.
  for (const l of list) {
    const hadFlag = Boolean(l.extra) && Object.entries(l.extra).some(([k, v]) => FLAG_TEST.test(String(v)) || FLAG_TEST.test(k));
    if (cleanLead(l, null)) changed.add(l);
    if (hadFlag) stats.flagsRemoved++;
  }
  // Pass 2: fill blank counties.
  const index = buildCountyIndex(list);
  for (const l of list) {
    if (l.county) continue;
    const c = inferCounty(l, index);
    if (c) { l.county = c; stats.countiesFilled++; changed.add(l); }
  }
  stats.changed = changed.size;
  return { stats, changed: [...changed] };
}

module.exports = {
  stripFlags, scrubFlagText, normalizeCity, normalizeCounty, normalizeOwnerEthnicity, normalizeOwnerGender,
  buildCountyIndex, inferCounty, cleanLead, cleanAll, FLAG_TEST
};
