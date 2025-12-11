
//#region 处理意图识别和商品提取

function handleLLM(text) {
  const regex = /```json([\s\S]*?)```/;
  const _res = text.replaceAll(/<think>[\s\S]*?<\/think>/g, '');
  const match = _res.match(regex);
  const res = match ? match[1].trim() : _res;

  // 更安全的注释移除，不会误删 URL 与字符串内容
  const str = res
    .replace(/\/\/(?!\s*http)[^\n]*/g, '')       // 去掉行注释，但保留 https://
    .replace(/\/\*[\s\S]*?\*\//g, '');           // 块注释

  let obj;
  try {
    obj = JSON.parse(str);
  } catch (e) {
    obj = {};
  }
  return obj;
}
function isNull(value) {
  return !value || value === 'null'
}
function filterProduct(history, product) {
  const product_name = []
  const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
  const item_name = {}
  add_item.forEach(o => item_name[o.name] = o)
  product.forEach(o => {
    switch (o.op_type) {
      case 'add':
      case 'delete':
      case 'update_qty':
      case 'update_spec':
        if (!isNull(o?.items?.[0]?.name) && !item_name[o.items[0].name]) {
          product_name.push(o.items[0].name)
        }
        break
      case 'replace_product':
        const items = Array.isArray(o?.items) ? Array.from(o.items) : []
        items.slice(0, 2).forEach(obj => {
          if (!isNull(obj?.name) && !item_name[obj.name]) {
            product_name.push(obj.name)
          }
        })
        break
    }
  })
  return product_name
}
function formatOperations() {

}
function main({text, history}) {
  const obj = handleLLM(text)
  const operation = Array.isArray(obj.operation) ? Array.from(obj.operation) : (!isNull(obj?.operation?.op_type) ? [obj.operation] : [])
  let intent, need_checkout = false
  const product_items = []
  const product_op = ['add', 'delete', 'update_qty', 'update_spec', 'replace_product']
  const op_type = product_op.concat(['recommend', 'checkout', 'cancel', 'none'])
  const op = operation.filter(o => op_type.includes(o.op_type))
  if (op.length === 0 || op.every(o => o.op_type === 'none')) {
    intent = 'none'
  }
  else if (!!op.find(o => o.op_type === 'recommend')) {
    intent = 'recommend'
  }
  else if (!!op.find(o => o.op_type === 'cancel')) {
    intent = 'cancel'
  }
  else if (op.every(o => o.op_type === 'checkout')) {
    intent = 'checkout'
  }
  else {
    for (const o of op) {
      if (product_op.includes(o.op_type)) {
        product_items.push(o)
      }
      if (o.op_type === 'checkout') {
        need_checkout = true
        break
      }
    }
    if (product_items.length === 0 && need_checkout) {
      intent = 'checkout'
    }
    else if (product_items.length > 0) {
      intent = 'product'
    }
    else {
      intent = 'none'
    }
  }
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  let product_name = []
  if (intent === 'cancel') {
    if (!!history?.item) {
      dify = '好的，已為您取消訂單，您可以重新點餐或提問。'
      product = []
    } else {
      dify = '抱歉，目前沒有訂單可以取消，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'checkout') {
    if (!!history?.item) {
      dify = '好的，已為您開啟結帳流程。'
      is_finish = true
    } else {
      dify = '抱歉，目前沒有訂單可以結帳，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'product') {
    product_name = filterProduct(history, product_items)
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    intent,
    product_items,
    product_name,
    answer,
    need_checkout,
  }
}

//#endregion
//#region 处理推荐检索

function parseToObject(str) {
  const obj = {};

  // 只把出现在 行首、分号或换行 后的 "key:" 识别为字段名
  const regex = /(^|;|\n)\s*([A-Za-z0-9_]+)\s*:/g;
  let match;
  const keys = [];

  while ((match = regex.exec(str)) !== null) {
    // match.index 是整个 match 的起始（包含前缀），
    // 找到 key 在 match[0] 中的偏移以算出 key 的全局起始位置
    const fullMatch = match[0];
    const keyName = match[2];
    const offsetInFull = fullMatch.indexOf(keyName);
    const keyIndex = match.index + offsetInFull;
    keys.push({ key: keyName, index: keyIndex });
  }

  for (let i = 0; i < keys.length; i++) {
    const current = keys[i];
    const next = keys[i + 1];

    const start = current.index + current.key.length + 1; // skip `key:`
    const end = next ? next.index : str.length;

    // 取片段并去掉收尾的分号与空白
    let value = str.slice(start, end).trim();
    value = value.replace(/^\s*;|;\s*$/g, "").trim();

    // 清除 value 末尾的 (数字)
    value = value.replace(/\(\d+\)\s*$/, "").trim();

    obj[current.key] = value;
  }

  return obj;
}
function main({result, history}) {
  const items = result.map(o => parseToObject(o?.content ?? '')).filter(o => !!o.id)
  const query_id = items.map(o => `'${o.id}'`)
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  if (items.length === 0) {
    dify += '抱歉，未檢索到相關產品，無法進行推薦。'
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    items,
    sql,
    answer,
  }
}

//#endregion
//#region 整合推荐信息

function parseRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(col => String(col).trim())
}
function parseMd(text) {
  const md = String(text).replace(/(?<!\|)\n(?!\|)/g, ' ').replaceAll('\r', ' ')
  const lines = md.split('\n')
  const head = parseRow(lines[0])
  const body = lines.slice(2)
  return body.map(line => {
    const obj = {}
    const arr = parseRow(line)
    head.forEach((key, index) => {
      obj[key] = arr[index]
    })
    return obj
  })
}
function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

  return null
}
function normalizeTemp(temp) {
  if (!temp) return null

  const text = String(temp).trim()

  // 冰类（冰、微冰、少冰、去冰、冰凉、冷 等）
  if (/[冰冷]/i.test(text)) return '冰的'

  // 热类（热、熱、溫、温、暖 等）
  if (/[热熱温溫暖]/i.test(text)) return '熱的'

  return null
}
function getOption(item, option_by_id, obj) {
  if (!!item) {
    const option = item.option
    const size_option = item.size_option
    const temp_option = item.temp_option
    return {
      option,
      size_option,
      temp_option,
    }
  }
  const option = option_by_id[obj.id] ?? {}
  const format = {}
  const size_option = []
  const temp_option = []
  Object.keys(option).forEach(o => {
    let key = normalizeSize(o)
    if (!!key) {
      format[key] = option[o]
      size_option.push(key)
    } else {
      key = normalizeTemp(o)
      format[key] = option[o]
      temp_option.push(key)
    }
  })
  return {
    option: format,
    size_option,
    temp_option,
  }
}
function main({text, items, history}) {
  const option_by_id = {}
  if (!!text) {
    const option = parseMd(text)
    option.forEach(o => {
      if (!option_by_id[o.product_id]) {
        option_by_id[o.product_id] = {}
      }
      option_by_id[o.product_id][o.name] = Number(o?.price ?? 0)
    })
  }
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  dify += '好的，為您推薦以下產品：\n'
  items.forEach(obj => {
    const { option, size_option, temp_option } = getOption(null, option_by_id, obj)
    const add = Object.keys(option).filter(k => option[k] > 0)
    let add_text = add.length > 0 ? `，其中：${add.map(o => `${o}+${option[o]}元`)}` : ''
    dify += `${obj.name}，可選容量：${size_option.join('、')}，可選溫度：${temp_option.join('、')}，單價：${obj.price}元${add_text}；\n`
  })
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    answer,
  }
}

//#endregion
//#region 处理闲聊

function main({text, history}) {
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = text
  let is_finish = false
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    answer
  }
}

//#endregion
//#region 处理检索商品名

function parseToObject(str) {
  const obj = {};

  // 只把出现在 行首、分号或换行 后的 "key:" 识别为字段名
  const regex = /(^|;|\n)\s*([A-Za-z0-9_]+)\s*:/g;
  let match;
  const keys = [];

  while ((match = regex.exec(str)) !== null) {
    // match.index 是整个 match 的起始（包含前缀），
    // 找到 key 在 match[0] 中的偏移以算出 key 的全局起始位置
    const fullMatch = match[0];
    const keyName = match[2];
    const offsetInFull = fullMatch.indexOf(keyName);
    const keyIndex = match.index + offsetInFull;
    keys.push({ key: keyName, index: keyIndex });
  }

  for (let i = 0; i < keys.length; i++) {
    const current = keys[i];
    const next = keys[i + 1];

    const start = current.index + current.key.length + 1; // skip `key:`
    const end = next ? next.index : str.length;

    // 取片段并去掉收尾的分号与空白
    let value = str.slice(start, end).trim();
    value = value.replace(/^\s*;|;\s*$/g, "").trim();

    // 清除 value 末尾的 (数字)
    value = value.replace(/\(\d+\)\s*$/, "").trim();

    obj[current.key] = value;
  }

  return obj;
}
function main({result, item}) {
  const kb = parseToObject(result[0]?.content ?? '')
  const res = {
    product_name: item,
    ...kb,
  }
  return {
    res,
  }
}

//#endregion
//#region 统一处理点餐商品

function isNull(value) {
  return !value || value === 'null'
}
function main({output, product_items, history}) {
  const query_id = []
  const item_id = {}
  const item_name = {}
  history?.item?.forEach(o => {
    item_id[o.id] = o
    item_name[o.name] = o
  })
  const by_name = {}
  if (!!output) {
    Array.from(output).forEach(o => by_name[o.product_name] = o)
  }
  let has_error = false
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  for (const op of product_items) {
    if (op.op_type === 'add') {
      const name = op?.items?.[0]?.name
      if (isNull(name)) {
        dify = '抱歉，無法新增商品，請指定商品名。'
        has_error = true
        break
      }
      if (!item_name[name]) {
        if (!by_name[name]?.id) {
          dify = `抱歉，無法新增商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_name[name]?.id && !item_id[by_name[name].id]) {
          query_id.push(`'${by_name[name].id}'`)
        }
      }
    }
    else if (op.op_type === 'delete') {
      const name = op?.items?.[0]?.name
      if (!history?.item) {
        dify = '抱歉，目前沒有訂單可以刪除商品，您可以重新點餐或提問。'
        has_error = true
        break
      }
      if (isNull(name)) {
        dify = '抱歉，無法刪除商品，請指定商品名。'
        has_error = true
        break
      }
      if (!item_name[name]) {
        if (!by_name[name]?.id) {
          dify = `抱歉，無法刪除商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_name[name]?.id && !item_id[by_name[name].id]) {
          dify = `抱歉，無法刪除商品，${name}不在訂單中`
          has_error = true
          break
        }
      }
    }
    else if (op.op_type === 'update_qty') {
      const name = op?.items?.[0]?.name
      if (!history?.item) {
        dify = '抱歉，目前沒有訂單可以修改商品，您可以重新點餐或提問。'
        has_error = true
        break
      }
      if (isNull(name)) {
        dify = '抱歉，無法修改商品，請指定商品名。'
        has_error = true
        break
      }
      if (!item_name[name]) {
        if (!by_name[name]?.id) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_name[name]?.id && !item_id[by_name[name].id]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中`
          has_error = true
          break
        }
      }
    }
    else if (op.op_type === 'update_spec') {
      const name = op?.items?.[0]?.name
      if (!history?.item) {
        dify = '抱歉，目前沒有訂單可以修改商品，您可以重新點餐或提問。'
        has_error = true
        break
      }
      if (isNull(name)) {
        dify = '抱歉，無法修改商品，請指定商品名。'
        has_error = true
        break
      }
      if (!item_name[name]) {
        if (!by_name[name]?.id) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目。`
          has_error = true
          break
        }
        if (!!by_name[name]?.id && !item_id[by_name[name].id]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中。`
          has_error = true
          break
        }
      }
    }
    else if (op.op_type === 'replace_product') {
      const source = op?.items?.[0]?.name
      const target = op?.items?.[1]?.name
      if (!history?.item) {
        dify = '抱歉，目前沒有訂單可以替換商品，您可以重新點餐或提問。'
        has_error = true
        break
      }
      if (isNull(source)) {
        dify = '抱歉，無法替換商品，請指定被替換的商品名。'
        has_error = true
        break
      }
      if (!item_name[source]) {
        if (!by_name[source]?.id) {
          dify = `抱歉，無法替換商品，${source}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_name[source]?.id && !item_id[by_name[source].id]) {
          dify = `抱歉，無法替換商品，${source}不在訂單中`
          has_error = true
          break
        }
      }
      if (isNull(target)) {
        dify = '抱歉，無法替換商品，請指定替換的商品名。'
        has_error = true
        break
      }
      if (!item_name[target]) {
        if (!by_name[target]?.id) {
          dify = `抱歉，無法替換商品，${target}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_name[target]?.id && !item_id[by_name[target].id]) {
          query_id.push(`'${by_name[target].id}'`)
        }
      }
    }
  }
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    sql,
    query_id,
    answer,
    has_error,
  }
}

//#endregion
//#region 整合产品信息

function parseRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(col => String(col).trim())
}
function parseMd(text) {
  const md = String(text).replace(/(?<!\|)\n(?!\|)/g, ' ').replaceAll('\r', ' ')
  const lines = md.split('\n')
  const head = parseRow(lines[0])
  const body = lines.slice(2)
  return body.map(line => {
    const obj = {}
    const arr = parseRow(line)
    head.forEach((key, index) => {
      obj[key] = arr[index]
    })
    return obj
  })
}
function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

  return null
}
function normalizeTemp(temp) {
  if (!temp) return null

  const text = String(temp).trim()

  // 冰类（冰、微冰、少冰、去冰、冰凉、冷 等）
  if (/[冰冷]/i.test(text)) return '冰的'

  // 热类（热、熱、溫、温、暖 等）
  if (/[热熱温溫暖]/i.test(text)) return '熱的'

  return null
}
function isNull(value) {
  return !value || value === 'null'
}
function getSize(obj, size_option) {
  const format_size = normalizeSize(obj.size)
  const default_size = size_option.find(o => o === '中杯') ?? size_option[0]
  return !!format_size && size_option.includes(format_size) ? format_size : default_size
}
function getTemp(obj, temp_option) {
  const name = !!obj.name ? obj.name : obj.product_name
  const format_temp = normalizeTemp(obj.temp)
  const def = normalizeTemp(name) ?? '冰的'
  const default_temp = temp_option.find(o => o === def) ?? temp_option[0]
  return !!format_temp && temp_option.includes(format_temp) ? format_temp : default_temp
}
function getQty(qty) {
  return isNull(qty) || Number.isNaN(Number(qty)) ? null : Number(qty)
}
function formatProduct(o) {
  const size = !!o.size ? o.size : o.size_option[0]
  const temp = !!o.temp ? o.temp : o.temp_option[0]
  return {
    name: o.name,
    price: o.price,
    options: [
      {
        name: size,
        price: o.option[size],
      },
      {
        name: temp,
        price: o.option[temp],
      },
    ]
  }
}
function getProduct(item) {
  const res = []
  const product = Array.isArray(item) ? Array.from(item) : []
  product.forEach(o => {
    for (let i = 0; i < o.qty; i++) {
      res.push(formatProduct(o))
    }
  })
  return res
}
function main({text, history, output, product_items, need_checkout}) {
  const option_by_id = {}
  if (!!text) {
    const option = parseMd(text)
    option.forEach(o => {
      if (!option_by_id[o.product_id]) {
        option_by_id[o.product_id] = {}
      }
      option_by_id[o.product_id][o.name] = Number(o?.price ?? 0)
    })
  }
  const item_id = {}
  const item_name = {}
  let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
  new_item.forEach(o => {
    item_id[o.id] = o
    item_name[o.name] = o
  })
  const by_name = {}
  if (!!output) {
    Array.from(output).forEach(o => by_name[o.product_name] = o)
  }
  const getObj = (name) => {
    const obj = !!item_name[name] ? item_name[name] : (!!item_id[by_name[name].id] ? item_id[by_name[name].id] : by_name[name])
    if (!!obj?.option) {
      const option = obj.option
      const size_option = obj.size_option
      const temp_option = obj.temp_option
      return {
        obj,
        option,
        size_option,
        temp_option,
      }
    }
    const option = option_by_id[obj.id] ?? {}
    const format = {}
    const size_option = []
    const temp_option = []
    Object.keys(option).forEach(o => {
      let key = normalizeSize(o)
      if (!!key) {
        format[key] = option[o]
        size_option.push(key)
      } else {
        key = normalizeTemp(o)
        format[key] = option[o]
        temp_option.push(key)
      }
    })
    return {
      obj,
      option: format,
      size_option,
      temp_option,
    }
  }
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  let is_error = false
  const success = {
    add: [],
    delete: [],
    update_qty: [],
    update_spec: [],
    replace_product: [],
  }
  for (const o of product_items) {
    if (o.op_type === 'add') {
      const name = o?.items?.[0]?.name
      const { obj, option, size_option, temp_option } = getObj(name)
      const qty = getQty(o?.items?.[0]?.qty)
      const size = getSize(o?.items?.[0], size_option)
      const temp = getTemp(o?.items?.[0], temp_option)
      const add_item = new_item.filter(o => o.name === obj.name && size === o.size && temp === o.temp)
      if (add_item.length > 0) {
        new_item = new_item.map(v => {
          if (v === add_item[0]) {
            return {
              ...v,
              qty: add_item[0].qty + Number(qty ?? 1),
            }
          }
          return v
        })
      }
      else {
        new_item.push({
          option,
          size_option,
          temp_option,
          id: obj.id,
          name: obj.name,
          qty: qty ?? 1,
          price: obj.price,
          size,
          temp,
        })
      }
      success.add.push({
        name: obj.name,
        size,
        temp,
        qty: qty ?? 1,
      })
    }
    else if (o.op_type === 'delete') {
      const name = o?.items?.[0]?.name
      const { obj } = getObj(name)
      const qty = getQty(o?.items?.[0]?.qty)
      const size = normalizeSize(o?.items?.[0]?.size)
      const temp = normalizeTemp(o?.items?.[0]?.temp)
      const del_item = new_item.filter(o => o.name === obj.name && (!size || size === o.size) && (!temp || temp === o.temp))
      if (del_item.length > 1) {
        dify = `抱歉，無法刪除商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`
        is_error = true
        break
      }
      if (del_item.length === 0) {
        dify = `抱歉，無法刪除商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`
        is_error = true
        break
      }
      if (!qty || qty >= del_item[0].qty) {
        new_item = new_item.filter(v => v !== del_item[0])
      }
      else {
        new_item = new_item.map(v => {
          if (v === del_item[0]) {
            return {
              ...v,
              qty: del_item[0].qty - Number(qty),
            }
          }
          return v
        })
      }
      success.delete.push({
        name: obj.name,
        size,
        temp,
        qty,
        qty_o: del_item[0].qty,
      })
    }
    else if (o.op_type === 'update_qty') {
      const name = o?.items?.[0]?.name
      const { obj } = getObj(name)
      const qty = getQty(o?.items?.[0]?.qty)
      const size = normalizeSize(o?.items?.[0]?.size)
      const temp = normalizeTemp(o?.items?.[0]?.temp)
      const qty_item = new_item.filter(o => o.name === obj.name && (!size || size === o.size) && (!temp || temp === o.temp))
      if (qty_item.length > 1) {
        dify = `抱歉，無法修改商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`
        is_error = true
        break
      }
      if (qty_item.length === 0) {
        dify = `抱歉，無法修改商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`
        is_error = true
        break
      }
      new_item = new_item.map(v => {
        if (v === qty_item[0]) {
          return {
            ...v,
            qty: qty ?? 1,
          }
        }
        return v
      })
      success.update_qty.push({
        name: obj.name,
        size,
        temp,
        qty: qty ?? 1,
      })
    }
    else if (o.op_type === 'update_spec') {
      const name = o?.items?.[0]?.name
      const { obj } = getObj(name)
      const qty = getQty(o?.items?.[0]?.qty)
      const size = normalizeSize(o?.items?.[0]?.size)
      const temp = normalizeTemp(o?.items?.[0]?.temp)
      const spec_item = new_item.filter(o => o.name === obj.name)
      if (spec_item.length > 1) {
        dify = `抱歉，無法修改商品，訂單中存在多款${name}。`
        is_error = true
        break
      }
      if (spec_item.length === 0) {
        dify = `抱歉，無法修改商品，${name}不在訂單中。`
        is_error = true
        break
      }
      const size_option = spec_item[0].size_option
      const temp_option = spec_item[0].temp_option
      if (!qty || qty >= spec_item[0].qty) {
        new_item = new_item.map(v => {
          if (v === spec_item[0]) {
            return {
              ...v,
              size: size ?? v.size,
              temp: temp ?? v.temp,
            }
          }
          return v
        })
      }
      else {
        new_item = new_item.map(v => {
          if (v === spec_item[0]) {
            return {
              ...v,
              qty: spec_item[0].qty - Number(qty ?? 1),
            }
          }
          return v
        })
        new_item.push({
          option: spec_item[0].option,
          size_option,
          temp_option,
          id: spec_item[0].id,
          name: spec_item[0].name,
          qty: qty ?? 1,
          price: spec_item[0].price,
          size: size ?? spec_item[0].size,
          temp: temp ?? spec_item[0].temp,
        })
      }
      success.update_spec.push({
        name: obj.name,
        size,
        temp,
        qty,
        qty_o: spec_item[0].qty,
      })
    }
    else if (o.op_type === 'replace_product') {
      const source_name = o?.items?.[0]?.name
      const target_name = o?.items?.[1]?.name
      const { obj: source_obj } = getObj(source_name)
      const { obj: target_obj, option: target_option, size_option: target_size_option, temp_option: target_temp_option } = getObj(target_name)
      const source_size = normalizeSize(o?.items?.[0]?.size)
      const source_temp = normalizeTemp(o?.items?.[0]?.temp)
      const target_size = normalizeSize(o?.items?.[1]?.size)
      const target_temp = normalizeTemp(o?.items?.[1]?.temp)
      const target_qty = getQty(o?.items?.[1]?.qty)
      const source_item = new_item.filter(o => o.name === source_obj.name && (!source_size || source_size === o.size) && (!source_temp || source_temp === o.temp))
      const target_item = new_item.filter(o => o.name === target_obj.name && (!target_size || target_size === o.size) && (!target_temp || target_temp === o.temp))
      if (source_item.length > 1) {
        dify = `抱歉，無法替換商品，訂單中存在多款${source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}。`
        is_error = true
        break
      }
      if (source_item.length === 0) {
        dify = `抱歉，無法替換商品，${source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}不在訂單中。`
        is_error = true
        break
      }
      if (target_item.length > 1) {
        dify = `抱歉，無法替換商品，訂單中存在多款${target_name}${!!target_size ? `，${target_size}`: ''}${!!target_temp ? `，${target_temp}`: ''}。`
        is_error = true
        break
      }
      const qty = target_qty
      const size = target_size ?? source_item[0].size
      const temp = target_temp ?? source_item[0].temp
      if (!qty || qty >= source_item[0].qty) {
        if (target_item.length === 0) {
          new_item = new_item.map(v => {
            if (v === source_item[0]) {
              return {
                option: target_option,
                size_option: target_size_option,
                temp_option: target_temp_option,
                id: target_obj.id,
                name: target_obj.name,
                qty: qty ?? 1,
                price: target_obj.price,
                size,
                temp,
              }
            }
            return v
          })
        }
        else {
          new_item = new_item.filter(v => v !== source_item[0]).map(v => {
            if (v === target_item[0]) {
              return {
                ...v,
                qty: target_item[0].qty + source_item[0].qty,
              }
            }
            return v
          })
        }
      }
      else {
        new_item = new_item.map(v => {
          if (v === source_item[0]) {
            return {
              ...v,
              qty: source_item[0].qty - Number(qty ?? 1),
            }
          }
          return v
        })
        if (target_item.length === 0) {
          new_item.push({
            option: target_option,
            size_option: target_size_option,
            temp_option: target_temp_option,
            id: target_obj.id,
            name: target_obj.name,
            qty: qty ?? 1,
            price: target_obj.price,
            size,
            temp,
          })
        }
        else {
          new_item = new_item.map(v => {
            if (v === target_item[0]) {
              return {
                ...v,
                qty: target_item[0].qty + Number(qty ?? 1),
              }
            }
            return v
          })
        }
      }
      success.replace_product.push({
        source_name: source_obj.name,
        target_name: target_obj.name,
        qty,
        qty_o: source_item[0].qty,
      })
    }
  }
  let new_history = {
    ...history
  }
  if (!is_error) {
    product = getProduct(new_item)
    new_history = {
      item: new_item,
      product,
    }
    dify = '好的，'
    if (success.add.length > 0) {
      dify += '已為您添加'
      success.add.forEach(o => {
        dify += `${o.qty}杯${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}；`
      })
    }
    if (success.delete.length > 0) {
      dify += '已為您刪除'
      success.delete.forEach(o => {
        dify += `${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}；`
      })
    }
    if (success.update_qty.length > 0) {
      success.update_qty.forEach(o => {
        dify += `已將${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}改為${o.qty ?? 1}杯；`
      })
    }
    if (success.update_spec.length > 0) {
      success.update_spec.forEach(o => {
        dify += `已將${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.name}改為${!!o.size ? `${o.size}`: ''}${!!o.temp ? `${o.temp}`: ''}；`
      })
    }
    if (success.replace_product.length > 0) {
      success.replace_product.forEach(o => {
        dify += `已將${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.source_name}替換為${o.target_name}；`
      })
    }
    if (need_checkout) {
      is_finish = true
      dify += '並為您開啟結帳流程。'
      new_history = {}
    }
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    new_history,
    answer,
    is_error,
  }
}

//#endregion
//#region 处理修改信息

function handleLLM(text) {
  const regex = /```json([\s\S]*?)```/;
  const _res = text.replaceAll(/<think>[\s\S]*?<\/think>/g, '');
  const match = _res.match(regex);
  const res = match ? match[1].trim() : _res;

  // 更安全的注释移除，不会误删 URL 与字符串内容
  const str = res
    .replace(/\/\/(?!\s*http)[^\n]*/g, '')       // 去掉行注释，但保留 https://
    .replace(/\/\*[\s\S]*?\*\//g, '');           // 块注释

  let obj;
  try {
    obj = JSON.parse(str);
  } catch (e) {
    obj = {};
  }
  return obj;
}
function isNull(value) {
  return !value || value === 'null'
}
function filterProduct(history, product) {
  const product_name = []
  const product_index = {}
  const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
  const item_name = {}
  add_item.forEach(o => item_name[o.name] = o)
  product.forEach(o => {
    if (!isNull(o.source_name) && !item_name[o.source_name]) {
      if (product_index[o.source_name] === undefined) {
        product_index[o.source_name] = product_name.length
        product_name.push(o.source_name)
      }
    }
    if (!isNull(o.target_name) && !item_name[o.target_name]) {
      if (product_index[o.target_name] === undefined) {
        product_index[o.target_name] = product_name.length
        product_name.push(o.target_name)
      }
    }
  })
  return {
    product_name,
  }
}
function main({text, history}) {
  const obj = handleLLM(text)
  const items = Array.isArray(obj.items) ? Array.from(obj.items) : (!isNull(obj?.items) ? [obj.items] : [])
  const { product_name } = filterProduct(history, items)
  return {
    items,
    product_name,
  }
}

//#endregion
//#region 处理检索产品名

function parseToObject(str) {
  const obj = {};

  // 只把出现在 行首、分号或换行 后的 "key:" 识别为字段名
  const regex = /(^|;|\n)\s*([A-Za-z0-9_]+)\s*:/g;
  let match;
  const keys = [];

  while ((match = regex.exec(str)) !== null) {
    // match.index 是整个 match 的起始（包含前缀），
    // 找到 key 在 match[0] 中的偏移以算出 key 的全局起始位置
    const fullMatch = match[0];
    const keyName = match[2];
    const offsetInFull = fullMatch.indexOf(keyName);
    const keyIndex = match.index + offsetInFull;
    keys.push({ key: keyName, index: keyIndex });
  }

  for (let i = 0; i < keys.length; i++) {
    const current = keys[i];
    const next = keys[i + 1];

    const start = current.index + current.key.length + 1; // skip `key:`
    const end = next ? next.index : str.length;

    // 取片段并去掉收尾的分号与空白
    let value = str.slice(start, end).trim();
    value = value.replace(/^\s*;|;\s*$/g, "").trim();

    // 清除 value 末尾的 (数字)
    value = value.replace(/\(\d+\)\s*$/, "").trim();

    obj[current.key] = value;
  }

  return obj;
}
function main({result, item}) {
  const kb = parseToObject(result[0]?.content ?? '')
  const res = {
    product_name: item,
    ...kb,
  }
  return {
    res,
  }
}

//#endregion
//#region 处理产品

function main({output, history}) {
  const query_id = []
  const item_id = {}
  history?.item?.forEach(o => {
    item_id[o.id] = o
  })
  const result = Array.isArray(output) ? Array.from(output) : []
  result.forEach(o => {
    if (!!o.id && !item_id[o.id]) {
      query_id.push(`'${o.id}'`)
    }
  })
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  return {
    sql,
    query_id,
  }
}

//#endregion
//#region 整合修改

function parseRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(col => String(col).trim())
}
function parseMd(text) {
  const md = String(text).replace(/(?<!\|)\n(?!\|)/g, ' ').replaceAll('\r', ' ')
  const lines = md.split('\n')
  const head = parseRow(lines[0])
  const body = lines.slice(2)
  return body.map(line => {
    const obj = {}
    const arr = parseRow(line)
    head.forEach((key, index) => {
      obj[key] = arr[index]
    })
    return obj
  })
}
function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

  return null
}
function normalizeTemp(temp) {
  if (!temp) return null

  const text = String(temp).trim()

  // 冰类（冰、微冰、少冰、去冰、冰凉、冷 等）
  if (/[冰冷]/i.test(text)) return '冰的'

  // 热类（热、熱、溫、温、暖 等）
  if (/[热熱温溫暖]/i.test(text)) return '熱的'

  return null
}
function isNull(value) {
  return !value || value === 'null'
}
function getQty(qty) {
  return isNull(qty) || Number.isNaN(Number(qty)) ? null : Number(qty)
}
function getOption(item, option_by_id, obj) {
  if (!!item) {
    const option = item.option
    const size_option = item.size_option
    const temp_option = item.temp_option
    return {
      option,
      size_option,
      temp_option,
    }
  }
  const option = option_by_id[obj.id] ?? {}
  const format = {}
  const size_option = []
  const temp_option = []
  Object.keys(option).forEach(o => {
    let key = normalizeSize(o)
    if (!!key) {
      format[key] = option[o]
      size_option.push(key)
    } else {
      key = normalizeTemp(o)
      format[key] = option[o]
      temp_option.push(key)
    }
  })
  return {
    option: format,
    size_option,
    temp_option,
  }
}
function getObj(item_name, by_name, item_id, name) {
  let source = null
  if (!!item_name[name]) {
    source = item_name[name]
  }
  else if (!!by_name[name]) {
    source = by_name[name]
    if (!!item_id[source.id]) {
      source = item_id[source.id]
    }
  }
  return source
}
function formatProduct(o) {
  const size = !!o.size ? o.size : o.size_option[0]
  const temp = !!o.temp ? o.temp : o.temp_option[0]
  return {
    name: o.name,
    price: o.price,
    options: [
      {
        name: size,
        price: o.option[size],
      },
      {
        name: temp,
        price: o.option[temp],
      },
    ]
  }
}
function getProduct(item) {
  const res = []
  const product = Array.isArray(item) ? Array.from(item) : []
  product.forEach(o => {
    for (let i = 0; i < o.qty; i++) {
      res.push(formatProduct(o))
    }
  })
  return res
}
function main({text, output, items, history, intent}) {
  const option_by_id = {}
  if (!!text) {
    const option = parseMd(text)
    option.forEach(o => {
      if (!option_by_id[o.product_id]) {
        option_by_id[o.product_id] = {}
      }
      option_by_id[o.product_id][o.name] = Number(o?.price ?? 0)
    })
  }
  const item_id = {}
  const item_name = {}
  let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
  new_item.forEach(o => {
    item_id[o.id] = o
    item_name[o.name] = o
  })
  const by_name = {}
  if (!!output) {
    Array.from(output).forEach(o => by_name[o.product_name] = o)
  }
  let product = getProduct(new_item)
  let dify = ''
  let is_finish = false
  let is_error = false
  if (new_item.length === 0) {
    dify = '抱歉，目前沒有訂單可以修改產品，您可以重新點餐或提問。'
    is_error = true
  }
  else {
    for (const edit of items) {
      let source = getObj(item_name, by_name, item_id, edit.source_name)
      let target = getObj(item_name, by_name, item_id, edit.target_name)
      if (!source?.size_option) {
        dify = `抱歉，目前訂單中不存在${edit.source_name}這一產品，請確認。`
        is_error = true
        break
      }
      const source_name = source?.name
      const target_name = target?.name
      const source_size = normalizeSize(edit.source_size)
      const source_temp = normalizeTemp(edit.source_temp)
      const target_size = normalizeSize(edit.target_size)
      const target_temp = normalizeTemp(edit.target_temp)
      const source_qty = getQty(edit.source_qty)
      const target_qty = getQty(edit.source_qty)
      const source_size_option = source?.size_option
      const source_temp_option = source?.temp_option
      if (intent === 'update_spec') {
        const spec_item = new_item.filter(o => o.name === source_name
          && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
          && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
        if (spec_item.length > 1) {
          dify = `抱歉，目前訂單中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else if (spec_item.length === 0) {
          dify = `抱歉，目前訂單中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else {
          const qty = target_qty ?? source_qty
          const size_option = spec_item[0].size_option
          const temp_option = spec_item[0].temp_option
          if (!qty || qty >= spec_item[0].qty) {
            new_item = new_item.map(v => {
              if (v === spec_item[0]) {
                return {
                  ...v,
                  size: target_size ?? v.size,
                  temp: target_temp ?? v.temp,
                }
              }
              return v
            })
          }
          else {
            new_item = new_item.map(v => {
              if (v === spec_item[0]) {
                return {
                  ...v,
                  qty: spec_item[0].qty - Number(qty ?? 1),
                }
              }
              return v
            })
            const size = target_size ?? spec_item[0].size
            const temp = target_temp ?? spec_item[0].temp
            new_item.push({
              option: spec_item[0].option,
              size_option,
              temp_option,
              id: spec_item[0].id,
              name: spec_item[0].name,
              qty: qty ?? 1,
              price: spec_item[0].price,
              size,
              temp,
            })
          }
          if (!dify) {
            dify = '好的，'
          }
          dify += `已將${!qty ? '' : `${qty >= replace_item[0].qty ? replace_item[0].qty : qty}杯`}${source_name}替換為${!!target_size ? target_size : ''}${!!target_temp ? (!!target_size ? '，' : '') + target_temp : ''}；`
        }
      }
      else if (intent === 'update_qty') {
        const qty_item = new_item.filter(o => o.name === source_name
          && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
          && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
        if (qty_item.length > 1) {
          dify = `抱歉，目前訂單中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else if (qty_item.length === 0) {
          dify = `抱歉，目前訂單中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else {
          new_item = new_item.map(v => {
            if (v === qty_item[0]) {
              return {
                ...v,
                qty: target_qty ?? (source_qty ?? 1),
              }
            }
            return v
          })
          if (!dify) {
            dify = '好的，'
          }
          dify += `已將${source_name}改為${target_qty ?? (source_qty ?? 1)}杯；`
        }
      }
      else if (intent === 'replace_product') {
        if (!target) {
          dify = `${edit.target_name}未檢索到相關項目，請確認。`
          is_error = true
          break
        }
        if (!!source && !!target) {
          const { option: format, size_option: target_size_option, temp_option: target_temp_option } = getOption(item_name[edit.target_name], option_by_id, target)
          const replace_item = new_item.filter(o => o.name === source_name
            && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
            && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
          const target_item = new_item.filter(o => o.name === target_name
            && (!target_size || target_size === o.size || (target_size_option.length === 1 && target_size === target_size_option[0]))
            && (!target_temp || target_temp === o.temp || (target_temp_option.length === 1 && target_temp === target_temp_option[0])))
          if (replace_item.length > 1) {
            dify = `抱歉，目前訂單中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
            is_error = true
            break
          }
          else if (replace_item.length === 0) {
            dify = `抱歉，目前訂單中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}這一產品，請確認。`
            is_error = true
            break
          }
          else if (target_item.length > 1) {
            dify = `抱歉，目前訂單中存在多款${edit.target_name}${!!target_size ? `，${target_size}`: ''}${!!target_temp ? `，${target_temp}`: ''}這一產品，請確認。`
            is_error = true
            break
          }
          else {
            const qty = target_qty
            const size = target_size ?? replace_item[0].size
            const temp = target_temp ?? replace_item[0].temp
            if (!qty || qty >= replace_item[0].qty) {
              if (target_item.length === 0) {
                new_item = new_item.map(v => {
                  if (v === replace_item[0]) {
                    return {
                      option: format,
                      size_option: target_size_option,
                      temp_option: target_temp_option,
                      id: target.id,
                      name: target.name,
                      qty: qty ?? 1,
                      price: target.price,
                      size,
                      temp,
                    }
                  }
                  return v
                })
              }
              else {
                new_item = new_item.filter(v => v !== replace_item[0]).map(v => {
                  if (v === target_item[0]) {
                    return {
                      ...v,
                      qty: target_item[0].qty + Number(qty ?? replace_item[0].qty),
                    }
                  }
                  return v
                })
              }
            } else {
              new_item = new_item.map(v => {
                if (v === replace_item[0]) {
                  return {
                    ...v,
                    qty: replace_item[0].qty - Number(qty ?? 1),
                  }
                }
                return v
              })
              if (target_item.length === 0) {
                new_item.push({
                  option: format,
                  size_option: target_size_option,
                  temp_option: target_temp_option,
                  id: target.id,
                  name: target.name,
                  qty: qty ?? 1,
                  price: target.price,
                  size,
                  temp,
                })
              }
              else {
                new_item = new_item.map(v => {
                  if (v === target_item[0]) {
                    return {
                      ...v,
                      qty: target_item[0].qty + Number(qty ?? 1),
                    }
                  }
                  return v
                })
              }
            }
            if (!dify) {
              dify = '好的，'
            }
            dify += `已將${!qty ? '' : `${qty >= replace_item[0].qty ? replace_item[0].qty : qty}杯`}${source_name}替換為${target_name}；`
          }
        }
      }
    }
  }
  let new_history = {
    ...history
  }
  if (!is_error) {
    new_history = {
      item: new_item,
    }
    product = getProduct(new_item)
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    new_history,
    answer,
  }
}

//#endregion

//#region 处理检索

function main({result}) {
  const chunk = []
  Array.from(result).forEach(o => {
    const content = o?.metadata?.child_chunks?.[0]?.content ?? ''
    if (content.startsWith('name:')) {
      chunk.push(content)
    }
  })
  return {
    chunk,
  }
}

//#endregion
