function debugSkuAtPenrith() {
  const SHOP  = PropertiesService.getScriptProperties().getProperty('SHOP_DOMAIN');
  const TOKEN = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  const API   = PropertiesService.getScriptProperties().getProperty('API_VERSION') || '2024-10';
  const LOCATION_NAME = 'Autospec 4x4 Penrith';
  const sku = 'AS-CD-1000-B'; // <<< change to test

  // 1) Resolve location ID
  const locId = (function resolve() {
    const q = `query { locations(first: 250) { edges { node { id name } } } }`;
    const r = UrlFetchApp.fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
      method:'post', contentType:'application/json',
      headers: {'X-Shopify-Access-Token': TOKEN},
      payload: JSON.stringify({query:q}), muteHttpExceptions:true
    });
    const body = JSON.parse(r.getContentText());
    const hit = (body.data?.locations?.edges||[]).map(e=>e.node).find(n => (n.name||'').trim()===LOCATION_NAME);
    return hit?.id || null;
  })();
  if (!locId) { Logger.log('Location not found'); return; }

  // 2) Try inventoryItems by SKU (our main approach)
  const q1 = `
    query Q($q:String!, $loc:ID!) {
      inventoryItems(first: 10, query: $q) {
        edges { node {
          sku
          tracked
          inventoryLevel(locationId:$loc) {
            location { name }
            quantities(names:["on_hand","available","committed","incoming"]) { name quantity }
          }
        } }
      }
    }`;
  const q1vars = { q: 'sku:(' + JSON.stringify(sku) + ')', loc: locId };
  const r1 = UrlFetchApp.fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method:'post', contentType:'application/json',
    headers:{'X-Shopify-Access-Token':TOKEN},
    payload: JSON.stringify({query:q1, variables:q1vars}), muteHttpExceptions:true
  });
  Logger.log('inventoryItems HTTP %s %s', r1.getResponseCode(), r1.getContentText());

  // 3) Fallback: productVariants by SKU to confirm Shopify’s stored SKU text + see tracked
  const q2 = `
    query V($q:String!, $loc:ID!) {
      productVariants(first: 10, query: $q) {
        edges { node {
          id sku
          inventoryItem {
            tracked
            inventoryLevel(locationId:$loc) {
              location { name }
              quantities(names:["on_hand","available","committed","incoming"]) { name quantity }
            }
          }
          product { title status }
        } }
      }
    }`;
  const q2vars = { q: "sku:'" + sku + "'", loc: locId };
  const r2 = UrlFetchApp.fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method:'post', contentType:'application/json',
    headers:{'X-Shopify-Access-Token':TOKEN},
    payload: JSON.stringify({query:q2, variables:q2vars}), muteHttpExceptions:true
  });
  Logger.log('productVariants HTTP %s %s', r2.getResponseCode(), r2.getContentText());
}

