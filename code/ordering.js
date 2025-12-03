
//#region 处理意图识别和商品提取

function handleLLM(text) {
  const regex = /```json([\s\S]*?)```/
  const _res = text.replaceAll(/<think>[\s\S]*?<\/think>/g, '')
  const match = _res.match(regex);
  const res = !!match ? match[1].trim() : _res
  const str = res.replaceAll(/\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '')
  let obj
  try {
    obj = JSON.parse(str)
  } catch (e) {
    obj = {}
  }
  return obj
}
function main({text}) {
  const obj = handleLLM(text)
  const intent = obj.intent || ''
  const product = Array.isArray(obj.items) ? Array.from(obj.items) : []
  const product_name = product.map(o => o.product_name_raw)
  return {
    intent,
    product,
    product_name,
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
function main({result, index, product}) {
  const obj = product[index]
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

function main({output}) {
  const miss_item = []
  const query_id = []
  const product = []
  Array.from(output).forEach(item => {
    if (!item.id) {
      miss_item.push(item.product_name_raw)
    } else {
      query_id.push(`'${item.id}'`)
      product.push(item)
    }
  })
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`

  return {
    miss_item,
    sql,
    product,
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
  if (/小|小杯/i.test(text)) return '小杯'

  return null
}
function normalizeTemperature(temp) {
  if (!temp) return null

  const text = String(temp).trim()

  // 冰类（冰、微冰、少冰、去冰、冰凉、冷 等）
  if (/[冰冷]/i.test(text)) return '冰的'

  // 热类（热、熱、溫、温、暖 等）
  if (/[热熱温溫暖]/i.test(text)) return '熱的'

  return null
}
function getReply(obj) {
  if (obj.need_size || obj.need_temp) {
    let reply = `您已选择${obj.name}，但其存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length + 1}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length + 1}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += '请选择。'
    return reply
  }
  const price = obj.price + obj.option[obj.size] + obj.option[obj.temp]
  const total = price * Number(obj.qty)
  const reply = `${obj.size}${obj.name}${obj.qty}杯，${obj.temp}，价格${obj.qty * price}元；\n`
  return { total, reply }
}
function main({text, miss_item, product}) {
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
  let answer = ''
  if (miss_item.length > 0) {
    answer += `抱歉，${miss_item.join('、')}未检索到相关品项。\n`
  }
  const item = []
  product.forEach(obj => {
    const size = normalizeSize(obj.size)
    const temp = normalizeTemperature(obj.temperature)
    const option = option_by_id[obj.id]
    const format = {}
    const size_option = []
    const temp_option = []
    Object.keys(option).forEach(o => {
      let key = normalizeSize(o)
      if (!!key) {
        format[key] = option[o]
        size_option.push(key)
      } else {
        key = normalizeTemperature(o)
        format[key] = option[o]
        temp_option.push(key)
      }
    })
    item.push({
      option: format,
      size_option,
      temp_option,
      name: obj.name,
      qty: obj.qty,
      price: obj.price,
      size,
      temp,
      need_size: size_option.length > 1 && !size,
      need_temp: temp_option.length > 1 && !temp,
    })
  })
  const reply = item.find(o => o.need_size || o.need_temp) ?? null
  const history = {
    reply,
    item,
  }
  if (!!reply) {
    answer += getReply(reply)
  } else {
    let total = 0, reply = ''
    const list = item.map(getReply)
    list.forEach(o => {
      reply += o.reply
      total += o.total
    })
    answer += `您已选择以下产品，总价${total}元，您可以选择结账、增改产品或者取消：\n`
    answer += reply
  }
  return {
    history,
    answer,
  }
}

//#endregion
