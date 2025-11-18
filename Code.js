/**** Script properties (Project Settings → Script properties)
 * SHOP_DOMAIN = autospec-group.myshopify.com
 * ADMIN_TOKEN = <Admin API access token>
 * API_VERSION = 2024-10
 ****************************************************************/

//TODO: Product freshfresh most not overwrite data in columns V, W and X

const SHOP = (PropertiesService.getScriptProperties().getProperty('SHOP_DOMAIN') || '').trim();
const TOKEN = (PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '').trim();
const API = (PropertiesService.getScriptProperties().getProperty('API_VERSION') || '2024-10').trim();

// Hard-code the single inventory location (must match Shopify Admin → Settings → Locations → Name)
const LOCATION_NAME = 'Autospec 4x4 Penrith';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Replenishment')
    .addItem('Refresh Inventory (autospec-group)', 'refreshInventory')
    .addToUi();
}

/**
 * NEW FLOW:
 * InventoryLive is the source of truth for SKUs.
 * - You type SKUs in InventoryLive!A
 * - This writes OnHand, Available, Committed, Inbound, LastSync into columns B:F on the SAME rows
 */
function refreshInventory() {
  if (!SHOP || !SHOP.includes('.myshopify.com')) {
    throw new Error("SCRIPT PROPERTY 'SHOP_DOMAIN' must look like 'autospec-group.myshopify.com' (no https://). Got: " + SHOP);
  }
  if (!TOKEN) throw new Error("SCRIPT PROPERTY 'ADMIN_TOKEN' (Admin API access token) is missing.");

  const ss = SpreadsheetApp.getActive();
  const inv = ss.getSheetByName('InventoryLive');
  if (!inv) throw new Error("Missing sheet: InventoryLive");

  // Ensure headers exist (do NOT clear Column A)
  inv.getRange(1, 1, 1, 6).setValues([['SKU', 'OnHand', 'Available', 'Committed', 'Inbound', 'LastSync']]);

  // Read SKU list from InventoryLive!A (manual list you maintain)
  const rowCount = Math.max(0, inv.getLastRow() - 1);
  if (rowCount === 0) { SpreadsheetApp.getUi().alert('No SKUs in InventoryLive!A'); return; }
  const aVals = inv.getRange(2, 1, rowCount, 1).getValues().flat();
  const skus = [...new Set(aVals.map(normalizeSku_).filter(Boolean))];
  if (!skus.length) { SpreadsheetApp.getUi().alert('No valid SKUs in InventoryLive!A'); return; }

  // Resolve location GID from name once
  const locId = resolveLocationIdByName_(SHOP, TOKEN, API, LOCATION_NAME);
  if (!locId) {
    const all = listLocationNames_(SHOP, TOKEN, API).join(', ');
    throw new Error("Location '" + LOCATION_NAME + "' not found. Available: " + all);
  }

  const rowsBySku = new Map(); // sku -> {on,av,co,inb}
  const now = new Date();

  // ---------- PASS 1: inventoryItems by SKU (fast path) ----------
  for (let i = 0; i < skus.length; i += 50) {
    const chunk = skus.slice(i, i + 50);
    const search = 'sku:(' + chunk.map(s => JSON.stringify(s)).join(' OR ') + ')';
    const query1 = `
      query Q($q:String!, $loc:ID!) {
        inventoryItems(first:250, query:$q) {
          edges { node {
            sku
            inventoryLevel(locationId:$loc) {
              quantities(names:["on_hand","available","committed","incoming"]) { name quantity }
            }
          } }
        }
      }`;
    const data1 = shopifyGraphQL_(SHOP, TOKEN, API, query1, { q: search, loc: locId });
    for (const e of (data1?.data?.inventoryItems?.edges || [])) {
      const sku = (e.node?.sku || '').trim();
      const lvl = e.node?.inventoryLevel;
      let on = 0, av = 0, co = 0, inb = 0;
      if (Array.isArray(lvl?.quantities)) {
        for (const q of lvl.quantities) {
          if (q.name === 'on_hand') on += q.quantity || 0;
          else if (q.name === 'available') av += q.quantity || 0;
          else if (q.name === 'committed') co += q.quantity || 0;
          else if (q.name === 'incoming') inb += q.quantity || 0;
        }
      }
      if (!on) on = av + co; // fallback if API omits on_hand
      rowsBySku.set(sku, { on, av, co, inb });
    }
  }

  // ---------- PASS 2: fallback via productVariants for any misses ----------
  const missing = skus.filter(s => !rowsBySku.has(s));
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 25) {
      const chunk = missing.slice(i, i + 25);
      const ors = chunk.map(s => "sku:'" + String(s).replace(/'/g, "\\'") + "'").join(' OR ');
      const query2 = `
        query V($q:String!, $loc:ID!) {
          productVariants(first:250, query:$q) {
            edges { node {
              sku
              inventoryItem {
                inventoryLevel(locationId:$loc) {
                  quantities(names:["on_hand","available","committed","incoming"]) { name quantity }
                }
              }
            } }
          }
        }`;
      const data2 = shopifyGraphQL_(SHOP, TOKEN, API, query2, { q: ors, loc: locId });
      for (const e of (data2?.data?.productVariants?.edges || [])) {
        const sku = (e.node?.sku || '').trim();
        const lvl = e.node?.inventoryItem?.inventoryLevel;
        let on = 0, av = 0, co = 0, inb = 0;
        if (Array.isArray(lvl?.quantities)) {
          for (const q of lvl.quantities) {
            if (q.name === 'on_hand') on += q.quantity || 0;
            else if (q.name === 'available') av += q.quantity || 0;
            else if (q.name === 'committed') co += q.quantity || 0;
            else if (q.name === 'incoming') inb += q.quantity || 0;
          }
        }
        if (!on) on = av + co;
        rowsBySku.set(sku, { on, av, co, inb });
      }
    }
  }

  // Build output aligned to the original A column rows
  const out = aVals.map(v => {
    const s = normalizeSku_(v);
    const t = s ? rowsBySku.get(s) : null;
    return t ? [t.on, t.av, t.co, t.inb, now] : [0, 0, 0, 0, now];
  });

  // Clear only B:F for existing rows, then write results back
  if (rowCount) inv.getRange(2, 2, rowCount, 5).clearContent();
  if (out.length) inv.getRange(2, 2, out.length, 5).setValues(out);

  // Optional: create Debug_NotFound with SKUs that returned 0/0/0/0
  const dbgName = 'Debug_NotFound';
  const old = ss.getSheetByName(dbgName);
  if (old) ss.deleteSheet(old);
  const misses = aVals
    .map(v => normalizeSku_(v))
    .map((s, idx) => ({ s, idx }))
    .filter(x => x.s && out[x.idx][0] === 0 && out[x.idx][1] === 0 && out[x.idx][2] === 0 && out[x.idx][3] === 0)
    .map(x => [x.s]);
  if (misses.length) {
    const dbg = ss.insertSheet(dbgName);
    dbg.getRange(1, 1, 1, 1).setValue('SKU not returned at location: ' + LOCATION_NAME);
    dbg.getRange(2, 1, misses.length, 1).setValues(misses);
  }
}

// ----- Helpers -----

function normalizeSku_(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  // replace fancy dashes with ASCII hyphen; strip zero-width; collapse spaces
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
  return s;
}

function resolveLocationIdByName_(domain, token, api, name) {
  const host = domain.includes('://') ? domain.split('://')[1] : domain;
  const url = `https://${host}/admin/api/${api}/graphql.json`;
  const query = `query { locations(first: 250) { edges { node { id name } } } }`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Shopify locations HTTP ' + code + ': ' + res.getContentText());
  const body = JSON.parse(res.getContentText());
  if (body.errors) throw new Error('Shopify locations error: ' + JSON.stringify(body.errors));
  const edges = body?.data?.locations?.edges || [];
  const hit = edges.map(e => e.node).find(n => (n.name || '').trim() === name);
  return hit ? hit.id : null;
}

function listLocationNames_(domain, token, api) {
  const host = domain.includes('://') ? domain.split('://')[1] : domain;
  const url = `https://${host}/admin/api/${api}/graphql.json`;
  const query = `query { locations(first: 250) { edges { node { id name } } } }`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return [];
  const body = JSON.parse(res.getContentText());
  return (body?.data?.locations?.edges || []).map(e => e.node.name);
}

function shopifyGraphQL_(domain, token, api, query, variables) {
  const host = domain.includes('://') ? domain.split('://')[1] : domain;
  if (!host || !host.endsWith('.myshopify.com')) {
    throw new Error("SHOP_DOMAIN must be like 'autospec-group.myshopify.com'. Got: " + domain);
  }
  const url = `https://${host}/admin/api/${api}/graphql.json`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Accept': 'application/json',
        'X-Shopify-Access-Token': token
      },
      payload: JSON.stringify({ query, variables: variables || null }),
      muteHttpExceptions: true,
      followRedirects: false
    });

    const code = res.getResponseCode();
    const ct = String(res.getHeaders()['Content-Type'] || '');
    const body = res.getContentText();

    if (code !== 200) {
      throw new Error(`Shopify GraphQL HTTP ${code}; Content-Type=${ct}; Body[0..400]= ${body.slice(0, 400)}`);
    }
    if (!/application\/json/i.test(ct)) {
      throw new Error(`Expected JSON but got Content-Type=${ct}; Body[0..400]= ${body.slice(0, 400)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`JSON parse error: ${e.message}; Body[0..200]= ${body.slice(0, 200)}`);
    }

    if (parsed.errors) {
      throw new Error('Shopify GraphQL errors: ' + JSON.stringify(parsed.errors));
    }
    return parsed;
  }
  throw new Error('Unexpected: retry loop exhausted');
}

function debugPingShop() {
  const SHOP = (PropertiesService.getScriptProperties().getProperty('SHOP_DOMAIN') || '').trim();
  const TOKEN = (PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '').trim();
  const API = (PropertiesService.getScriptProperties().getProperty('API_VERSION') || '2024-10').trim();

  const url = `https://${SHOP}/admin/api/${API}/graphql.json`;
  const query = '{ shop { name myshopifyDomain } }';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Accept': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true,
    followRedirects: false
  });

  Logger.log('HTTP %s', res.getResponseCode());
  Logger.log('Content-Type: %s', res.getHeaders()['Content-Type']);
  Logger.log('Body[0..400]: %s', res.getContentText().slice(0, 400));
}

/***********************
 * ProductsExport build
 ***********************/
const TARGET_VENDOR = 'Autospec 4x4';
const ALLOWED_STATUSES = new Set(['ACTIVE', 'UNLISTED']); // include these only
const EXCLUDED_TITLE_PREFIXES = ['Scratch & Dent -'];      // startsWith match, case-sensitive
const EXCLUDED_PRODUCT_TYPES = [
  'GWM Bundle', 'Bolt Fitting Kit', 'Bolt', 'Washer', 'Nut', 'Screw',
  'Suspension', 'Nuts & Bolts', 'Colour Coding', 'Freight', 'Nutsert'
];

// helper: tag -> Supplier
const SUPPLIER_TAG_MAP = { hct: 'Hangzhou Case Tools' };  // extend as needed
const SUPPLIER_DEFAULT = '';
function deriveSupplierFromTags_(tags, vendor) {
  const set = new Set((tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean));
  for (const key of Object.keys(SUPPLIER_TAG_MAP)) if (set.has(key.toLowerCase())) return SUPPLIER_TAG_MAP[key];
  return SUPPLIER_DEFAULT; // or: return vendor || SUPPLIER_DEFAULT;
}

// helper: boolean -> 'Y'/'N'
function boolToYN(b) { return b ? 'Y' : 'N'; }


// Menu entry
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Replenishment')
    .addItem('Refresh Inventory (autospec-group)', 'refreshInventory')
}

function refreshProductsExport() {
  const ss = SpreadsheetApp.getActive();
  const sheetName = 'ProductsExport';
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);

  const TARGET_VENDOR = 'Autospec 4x4';
  const ALLOWED_STATUSES = new Set(['ACTIVE', 'UNLISTED']);
  const EXCLUDED_TITLE_PREFIXES = ['Scratch & Dent -'];
  const EXCLUDED_PRODUCT_TYPES = [
    'GWM Bundle', 'Bolt Fitting Kit', 'Bolt', 'Washer', 'Nut', 'Screw',
    'Suspension', 'Nuts & Bolts', 'Colour Coding', 'Freight', 'Nutsert'
  ];

  const queryStr = `(status:active OR status:unlisted) vendor:'${TARGET_VENDOR.replace(/'/g, "\\'")}'`;
  const rows = [];
  const seenSku = new Set();

  let after = null;
  const pageSize = 250;

  const query = `
    query Q($first:Int!, $after:String, $query:String!) {
      products(first:$first, after:$after, query:$query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            vendor
            productType
            status
            publishedOnCurrentPublication
            updatedAt
            handle
            tags
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            variants(first:250) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryItem { unitCost { amount currencyCode } }
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }`;

  while (true) {
    const resp = shopifyGraphQL_(SHOP, TOKEN, API, query, { first: pageSize, after, query: queryStr });
    const edges = resp?.data?.products?.edges || [];

    for (const e of edges) {
      const p = e.node;
      if (!ALLOWED_STATUSES.has(String(p.status || '').toUpperCase())) continue;
      if (String(p.vendor || '') !== TARGET_VENDOR) continue;

      let skipByTitle = false;
      for (const pref of EXCLUDED_TITLE_PREFIXES)
        if ((p.title || '').startsWith(pref)) { skipByTitle = true; break; }
      if (skipByTitle) continue;

      if (EXCLUDED_PRODUCT_TYPES.includes(String(p.productType || ''))) continue;

      const supplier = deriveSupplierFromTags_(p.tags || [], p.vendor);

      const vEdges = p?.variants?.edges || [];
      for (const ve of vEdges) {
        const v = ve.node;
        const sku = String(v?.sku || '').trim();
        if (!sku) continue;
        if (seenSku.has(sku)) continue;
        seenSku.add(sku);

        const so = Array.isArray(v.selectedOptions) ? v.selectedOptions : [];
        const o1 = so[0] || {}, o2 = so[1] || {}, o3 = so[2] || {};

        // RRP: product-level price first, fallback to variant price
        const productRrp = p?.priceRangeV2?.minVariantPrice?.amount;
        const rrp = productRrp || v?.price || '';

        // Cost: inventoryItem.unitCost.amount
        const cost = v?.inventoryItem?.unitCost?.amount || '';

        rows.push([
          p.id, p.title, p.vendor, p.productType, p.status,
          boolToYN(p.publishedOnCurrentPublication),
          p.updatedAt, p.handle, '',
          String(o1.name || ''), String(o1.value || ''),
          String(o2.name || ''), String(o2.value || ''),
          String(o3.name || ''), String(o3.value || ''),
          v.id, v.title, sku, supplier, rrp, cost
        ]);
      }
    }

    const pageInfo = resp?.data?.products?.pageInfo;
    if (pageInfo?.hasNextPage) after = pageInfo.endCursor; else break;
  }

  rows.sort((a, b) => {
    const t1 = (a[1] || '').localeCompare(b[1] || '');
    return t1 !== 0 ? t1 : (a[18] || '').localeCompare(b[18] || '');
  });

  const headers = [
    'ProductID', 'ProductTitle', 'Vendor', 'ProductType', 'Status', 'PublishedOnline',
    'UpdatedAt', 'Handle', '', 'Option1Name', 'Option1Value', 'Option2Name', 'Option2Value',
    'Option3Name', 'Option3Value', 'VariantID', 'VariantTitle', 'VariantSKU',
    'Supplier', 'RRP', 'Cost'
  ];

  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
}

