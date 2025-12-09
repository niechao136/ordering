
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
    if (!isNull(o.product_name) && !item_name[o.product_name]) {
      product_name.push(o.product_name)
    }
  })
  return product_name
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
function main({text, history}) {
  const obj = handleLLM(text)
  const intent = String(obj.intent || '')
  const items = Array.isArray(obj.items) ? Array.from(obj.items) : (!isNull(obj?.items?.product_name) ? [obj.items] : [])
  let product = getProduct(history.item)
  let dify = ''
  let is_finish = false
  let product_name = []
  if (intent === 'cancel') {
    if (!!history.item) {
      dify = '好的，已為您取消訂單，您可以重新點餐或提問。'
      product = []
    } else {
      dify = '抱歉，目前沒有訂單可以取消，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'checkout') {
    if (!!history.item) {
      dify = '好的，已為您開啟結帳流程。'
      is_finish = true
    } else {
      dify = '抱歉，目前沒有訂單可以結帳，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'mixed') {
    dify = '抱歉，目前暫不支援一次處理多種操作，請分次操作。'
  }
  else if (intent === 'add' || intent === 'delete') {
    product_name = filterProduct(history, items)
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    intent,
    items,
    product_name,
    answer,
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
function main({result, item, items}) {
  const obj = items.find(o => o.product_name === item)
  const kb = parseToObject(result[0]?.content ?? '')
  const res = {
    ...obj,
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
function main({output, items, history}) {
  const query_id = []
  const list = []
  const item_id = {}
  history?.item?.forEach(o => {
    item_id[o.id] = o
  })
  const by_name = {}
  if (!!output) {
    Array.from(output).forEach(o => by_name[o.product_name] = o)
  }
  const miss_item = []
  items.forEach(o => {
    if (!!by_name[o.product_name]) {
      const obj = by_name[o.product_name]
      if (!!obj.id && !item_id[obj.id]) {
        query_id.push(`'${obj.id}'`)
        list.push(obj)
      } else {
        miss_item.push(isNull(o.product_name) ? '' : o.product_name)
      }
    } else if (!!o.product_name) {
      list.push(o)
    } else {
      miss_item.push(isNull(o.product_name) ? '' : o.product_name)
    }
  })
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  return {
    sql,
    items: list,
    query_id,
    miss_item,
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
  const format_temp = normalizeTemp(obj.temperature)
  const def = normalizeTemp(name) ?? '冰的'
  const default_temp = temp_option.find(o => o === def) ?? temp_option[0]
  return !!format_temp && temp_option.includes(format_temp) ? format_temp : default_temp
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
function main({text, history, items, intent, miss_item}) {
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
  let product = getProduct(new_item)
  let dify = ''
  let is_finish = false
  let is_error = false
  if (miss_item.length > 0) {
    dify = `抱歉，${miss_item.join('、')}未檢索到相關項目。`
    is_error = true
  }
  else if (intent === 'delete' && new_item.length === 0) {
    dify = '抱歉，目前沒有訂單可以刪除產品，您可以重新點餐或提問。'
    is_error = true
  }
  else {
    for (const obj of items) {
      let item = !obj.id ? item_name[obj.product_name] : (!!item_id[obj.id] ? item_id[obj.id] : null)
      if (!item && intent === 'delete') {
        dify += `抱歉，目前訂單中不存在${obj.product_name}這一產品，請確認。`
        is_error = true
        break
      }
      const name = !!obj.name ? obj.name : obj.product_name
      const { option, size_option, temp_option } = getOption(item, option_by_id, obj)
      const qty = getQty(obj?.qty)
      if (intent === 'add') {
        const size = getSize(obj, size_option)
        const temp = getTemp(obj, temp_option)
        const add_item = new_item.filter(o => o.name === name && size === o.size && temp === o.temp)
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
            id: !!item ? item.id : obj.id,
            name: name,
            qty: qty ?? 1,
            price: obj.price,
            size,
            temp,
          })
        }
        if (!dify) {
          dify = '好的，以為您添加'
        }
        dify += `${qty ?? 1}杯${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}；`
      }
      else if (intent === 'delete') {
        const size = normalizeSize(obj.size)
        const temp = normalizeTemp(obj.temperature)
        const del_item = new_item.filter(o => o.name === name
          && (!size || size === o.size || (size_option.length === 1 && size === size_option[0]))
          && (!temp || temp === o.temp || (temp_option.length === 1 && temp === temp_option[0])))
        if (del_item.length > 1) {
          dify = `抱歉，目前訂單中存在多款${obj.product_name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else if (del_item.length === 0) {
          dify = `抱歉，目前訂單中不存在${obj.product_name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}這一產品，請確認。`
          is_error = true
          break
        }
        else {
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
          if (!dify) {
            dify = '好的，已為您刪除'
          }
          dify += `${!qty ? '' : `${qty >= del_item[0].qty ? del_item[0].qty : qty}杯`}${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}；`
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
function main({result, history}) {
  const items = result.map(o => parseToObject(o?.content ?? '')).filter(o => !!o.id)
  const query_id = items.map(o => `'${o.id}'`)
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  let product = getProduct(history.item)
  let dify = ''
  let is_finish = false
  if (items.length === 0) {
    dify += '抱歉，未检索到相关产品，无法进行推荐。'
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
  let product = getProduct(history.item)
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
function main({text, history}) {
  let product = getProduct(history.item)
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
