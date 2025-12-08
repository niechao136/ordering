
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
function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

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
    const error = !!obj.size || !!obj.temp
    let reply = `您已选择${obj.name}${!!obj.size ? '，' + obj.size : ''}${!!obj.temp ? '，' + obj.temp : ''}，但其${error ? '只' : ''}存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += `请${error ? '重新' : ''}选择或者取消。`
    return reply
  }
  const size = obj.size_option.length === 1 && obj.size_option[0] !== obj.size ? obj.size_option[0] : obj.size
  const temp = obj.temp_option.length === 1 && obj.temp_option[0] !== obj.temp ? obj.temp_option[0] : obj.temp
  const price = Number(obj.price) + Number(obj.option[size]) + Number(obj.option[temp])
  const total = price * Number(obj.qty)
  const reply = `${obj.name}${obj.qty}杯，${obj.size}（${size === obj.size ? `可选：${obj.size_option.join('、')}` : `但其只有${size}`}），${obj.temp}（${temp === obj.temp ? `可选：${obj.temp_option.join('、')}` : `但其只有${temp}`}），价格${obj.qty * price}元；\n`
  return { total, reply }
}
function handleReply(history, query, intent) {
  let new_reply = { ...history.reply }
  if (!new_reply.size) {
    const size = normalizeSize(query)
    if (!!size && new_reply.size_option.includes(size)) {
      new_reply.size = size
      new_reply.need_size = false
    }
  }
  if (!new_reply.temp) {
    const temp = normalizeTemperature(query)
    if (!!temp && new_reply.temp_option.includes(temp)) {
      new_reply.temp = temp
      new_reply.need_temp = false
    }
  }
  const new_item = history.item.map(o => {
    if (o.id !== new_reply.id) {
      return o
    }
    return new_reply
  })
  if (!!new_reply.size && !!new_reply.temp) {
    new_reply = new_item.find(o => o.need_size || o.need_temp) ?? null
  }
  let new_history = {
    reply: new_reply,
    item: new_item,
  }
  let answer = ''
  if (intent === 'cancel') {
    answer = '已为您取消订单，您可以重新点餐或者提问。'
    new_history = {}
  }
  else if (!!new_reply) {
    answer += getReply(new_reply)
  }
  else {
    let total = 0, reply = ''
    const list = new_item.map(getReply)
    list.forEach(o => {
      reply += o.reply
      total += o.total
    })
    answer += `您已选择以下产品，总价${total}元，您可以选择结账、增改删除产品或者取消：\n`
    answer += reply
  }
  return {
    history: new_history,
    answer,
  }
}
function filterProduct(history, product) {
  const product_name = []
  const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
  const item_name = {}
  add_item.forEach(o => item_name[o.name] = o)
  product.forEach(o => {
    if (!item_name[o.product_name]) {
      product_name.push(o.product_name)
    }
  })
  return product_name
}
function main({text, history, query}) {
  const obj = handleLLM(text)
  const intent = String(obj.intent || '')
  const product = Array.isArray(obj.items) ? Array.from(obj.items) : (!!obj.items ? [obj.items] : [])
  const is_reply = !!history.reply
  let new_history = {}
  let answer = ''
  let product_name = []
  if (is_reply) {
    const reply = handleReply(history, query, intent)
    new_history = reply.history
    answer = reply.answer
  }
  else if (intent === 'cancel') {
    if (!!history.item) {
      answer = '已为您取消订单，您可以重新点餐或者提问。'
    } else {
      answer = '目前没有订单可以取消，您可以重新点餐或者提问。'
    }
  }
  else if (intent === 'checkout') {
    if (!!history.item) {
      answer = '结账'
    } else {
      answer = '目前没有订单可以结账，您可以重新点餐或者提问。'
    }
  }
  else if (intent === 'mixed') {
    answer = '目前暂不支持一次处理多种操作，请您分次操作。'
  }
  else if (intent === 'add' || intent === 'delete') {
    product_name = filterProduct(history, product)
  }
  return {
    is_reply,
    intent,
    product,
    product_name,
    new_history,
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
function main({result, index, product, product_name}) {
  const obj = product.find(o => o.product_name === product_name[index])
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

function main({output, product, history}) {
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
  product.forEach(o => {
    if (!!by_name[o.product_name]) {
      const obj = by_name[o.product_name]
      if (!!obj.id && !item_id[obj.id]) {
        query_id.push(`'${obj.id}'`)
        list.push(obj)
      } else {
        miss_item.push(o.product_name)
      }
    } else {
      list.push(o)
    }
  })
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  return {
    sql,
    product: list,
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
    const error = !!obj.size || !!obj.temp
    let reply = `您已选择${obj.name}${!!obj.size ? '，' + obj.size : ''}${!!obj.temp ? '，' + obj.temp : ''}，但其${error ? '只' : ''}存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += `请${error ? '重新' : ''}选择。`
    return reply
  }
  const size = obj.size_option.length === 1 && obj.size_option[0] !== obj.size ? obj.size_option[0] : obj.size
  const temp = obj.temp_option.length === 1 && obj.temp_option[0] !== obj.temp ? obj.temp_option[0] : obj.temp
  const price = Number(obj.price) + Number(obj.option[size]) + Number(obj.option[temp])
  const total = price * Number(obj.qty)
  const reply = `${obj.name}${obj.qty}杯，${obj.size}（${size === obj.size ? `可选：${obj.size_option.join('、')}` : `但其只有${size}`}），${obj.temp}（${temp === obj.temp ? `可选：${obj.temp_option.join('、')}` : `但其只有${temp}`}），价格${obj.qty * price}元；\n`
  return { total, reply }
}
function main({text, history, product, intent, miss_item}) {
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
  history?.item?.forEach(o => {
    item_id[o.id] = o
    item_name[o.name] = o
  })
  let answer = ''
  let is_error = false
  if (miss_item.length > 0) {
    answer += `抱歉，${miss_item.join('、')}未检索到相关品项。\n`
  }
  let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
  if (intent === 'delete' && new_item.length === 0) {
    answer += '目前没有订单可以删除产品，您可以重新点餐或者提问。\n'
    is_error = true
  }
  else {
    product.forEach(obj => {
      let item = null
      if (!obj.id) {
        item = item_name[obj.product_name]
      }
      else if (!!item_id[obj.id]) {
        item = item_id[obj.id]
      }
      if (!item && intent === 'delete') {
        answer += `目前订单中不存在${obj.product_name}这一产品，请确认。\n`
        is_error = true
      }
      else {
        const name = !!obj.name ? obj.name : obj.product_name
        const size = normalizeSize(obj.size)
        const temp = normalizeTemperature(obj.temperature)
        const option = !!item ? item.option : option_by_id[obj.id] ?? {}
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
        const qty = Number.isNaN(Number(obj?.qty)) || obj?.qty === null ? null : Number(obj?.qty)
        if (intent === 'add') {
          const add_item = new_item.filter(o => o.name === name
            && (size === o.size || (size_option.length === 1 && (!size || size === size_option[0])))
            && (temp === o.temp || (temp_option.length === 1 && (!temp || temp === temp_option[0]))))
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
              option: format,
              size_option,
              temp_option,
              id: !!item ? item.id : obj.id,
              name: name,
              qty: qty ?? 1,
              price: obj.price,
              size,
              temp,
              need_size: size_option.length > 1 && (!size || !size_option.includes(size)),
              need_temp: temp_option.length > 1 && (!temp || !temp_option.includes(temp)),
            })
          }
        }
        else if (intent === 'delete') {
          const del_item = new_item.filter(o => o.name === name
            && (!size || size === o.size || (size_option.length === 1 && size === size_option[0]))
            && (!temp || temp === o.temp || (temp_option.length === 1 && temp === temp_option[0])))
          if (del_item.length > 1) {
            answer += `目前订单中存在多款${obj.product_name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}这一产品，请确认。\n`
            is_error = true
          }
          else if (del_item.length === 0) {
            answer += `目前订单中不存在${obj.product_name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}这一产品，请确认。\n`
            is_error = true
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
          }
        }
      }
    })
  }
  let new_history = {
    ...history
  }
  if (!is_error) {
    const reply = new_item.find(o => o.need_size || o.need_temp) ?? null
    new_history = {
      reply,
      item: new_item,
    }
    if (!!reply) {
      answer += getReply(reply)
    } else {
      let total = 0, reply = ''
      const list = new_item.map(getReply)
      list.forEach(o => {
        reply += o.reply
        total += o.total
      })
      answer += `您已选择以下产品，总价${total}元，您可以选择结账、增改删除产品或者取消：\n`
      answer += reply
    }
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
function main({result}) {
  const product = result.map(o => parseToObject(o?.content ?? '')).filter(o => !!o.id)
  const query_id = product.map(o => `'${o.id}'`)
  const sql = `SELECT * FROM pos.product_option WHERE product_id IN (${query_id.join(', ')});`
  let answer = ''
  if (product.length === 0) {
    answer += '抱歉，未检索到相关产品，无法进行推荐。'
  }
  return {
    product,
    sql,
    answer,
  }
}

//#endregion
//#region 处理推荐检索

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
function normalizeTemperature(temp) {
  if (!temp) return null

  const text = String(temp).trim()

  // 冰类（冰、微冰、少冰、去冰、冰凉、冷 等）
  if (/[冰冷]/i.test(text)) return '冰的'

  // 热类（热、熱、溫、温、暖 等）
  if (/[热熱温溫暖]/i.test(text)) return '熱的'

  return null
}
function main({text, product}) {
  let answer = ''
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
  answer += '为您推荐以下产品：\n'
  product.forEach(obj => {
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
    const add = Object.keys(format).filter(k => format[k] > 0)
    let add_text = add.length > 0 ? `，其中：${add.map(o => `${o}+${format[o]}元`)}` : ''
    answer += `${obj.name}，可选容量：${size_option.join('、')}，可选温度：${temp_option.join('、')}，单价：${obj.price}元${add_text}；\n`
  })
  return {
    answer,
  }
}

//#endregion
//#region 解析历史

function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

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
    const error = !!obj.size || !!obj.temp
    let reply = `您已选择${obj.name}${!!obj.size ? '，' + obj.size : ''}${!!obj.temp ? '，' + obj.temp : ''}，但其${error ? '只' : ''}存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += `请${error ? '重新' : ''}选择。`
    return reply
  }
  const size = obj.size_option.length === 1 && obj.size_option[0] !== obj.size ? obj.size_option[0] : obj.size
  const temp = obj.temp_option.length === 1 && obj.temp_option[0] !== obj.temp ? obj.temp_option[0] : obj.temp
  const price = Number(obj.price) + Number(obj.option[size]) + Number(obj.option[temp])
  const total = price * Number(obj.qty)
  const reply = `${obj.name}${obj.qty}杯，${obj.size}（${size === obj.size ? `可选：${obj.size_option.join('、')}` : `但其只有${size}`}），${obj.temp}（${temp === obj.temp ? `可选：${obj.temp_option.join('、')}` : `但其只有${temp}`}），价格${obj.qty * price}元；\n`
  return { total, reply }
}
function main({history, query}) {
  const is_reply = !!history.reply
  let new_reply = {
    ...history.reply
  }
  let new_item = history.item.map(o => o)
  if (is_reply) {
    if (!new_reply.size) {
      const size = normalizeSize(query)
      if (!!size && new_reply.size_option.includes(size)) {
        new_reply.size = size
        new_reply.need_size = false
      }
    }
    if (!new_reply.temp) {
      const temp = normalizeTemperature(query)
      if (!!temp && new_reply.temp_option.includes(temp)) {
        new_reply.temp = temp
        new_reply.need_temp = false
      }
    }
    new_item = history.item.map(o => {
      if (o.id !== new_reply.id) {
        return o
      }
      return new_reply
    })
    if (!!new_reply.size && !!new_reply.temp) {
      new_reply = new_item.find(o => o.need_size || o.need_temp) ?? null
    }
  }
  const new_history = {
    reply: new_reply,
    item: new_item,
  }
  let answer = ''
  if (is_reply) {
    if (!!new_reply) {
      answer += getReply(new_reply)
    } else {
      let total = 0, reply = ''
      const list = new_item.map(getReply)
      list.forEach(o => {
        reply += o.reply
        total += o.total
      })
      answer += `您已选择以下产品，总价${total}元，您可以选择结账、增改删除产品或者取消：\n`
      answer += reply
    }
  }
  const info = JSON.stringify(history.item)
  return {
    new_history,
    answer,
    is_reply,
    info,
  }
}

//#endregion
//#region 处理订单操作识别

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
function normalizeSize(size) {
  if (!size) return null

  const text = String(size).trim()

  if (/大|大杯/i.test(text)) return '大杯'
  if (/中|中杯/i.test(text)) return '中杯'

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
    const error = !!obj.size || !!obj.temp
    let reply = `您已选择${obj.name}${!!obj.size ? '，' + obj.size : ''}${!!obj.temp ? '，' + obj.temp : ''}，但其${error ? '只' : ''}存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += `请${error ? '重新' : ''}选择。`
    return reply
  }
  const size = obj.size_option.length === 1 && obj.size_option[0] !== obj.size ? obj.size_option[0] : obj.size
  const temp = obj.temp_option.length === 1 && obj.temp_option[0] !== obj.temp ? obj.temp_option[0] : obj.temp
  const price = Number(obj.price) + Number(obj.option[size]) + Number(obj.option[temp])
  const total = price * Number(obj.qty)
  const reply = `${obj.name}${obj.qty}杯，${obj.size}（${size === obj.size ? `可选：${obj.size_option.join('、')}` : `但其只有${size}`}），${obj.temp}（${temp === obj.temp ? `可选：${obj.temp_option.join('、')}` : `但其只有${temp}`}），价格${obj.qty * price}元；\n`
  return { total, reply }
}
function main({text, history}) {
  const obj = handleLLM(text)
  let intent = obj.intent || ''
  const action = Array.isArray(obj.items) ? Array.from(obj.items) : (!!obj.items ? [obj.items] : [])
  if (action.length > 0) {
    intent = 'product'
  }
  const product = [], query_product = [], query_name = []
  action.forEach(o => {
    switch (o.op_type) {
      case 'add':
        const add_product = o?.target_item ?? o?.source_item
        const add_in = history.item.find(o => o.name === add_product.product_name)
        if (!add_in) {
          query_product.push({
            op_type: o.op_type,
            ...add_product,
          })
          query_name.push(add_product.product_name)
        }
        product.push({
          op_type: o.op_type,
          ...add_product,
        })
        break
      case 'delete':
        const del_product = o?.source_item ?? o?.target_item
        const del_in = history.item.find(o => o.name === del_product.product_name)
        if (!del_in) {
          query_product.push({
            op_type: o.op_type,
            ...del_product,
          })
          query_name.push(del_product.product_name)
        }
        product.push({
          op_type: o.op_type,
          ...del_product,
        })
        break
      case 'update_spec':
        const spec_product = o?.target_item ?? o?.source_item
        const spec_in = history.item.find(o => o.name === spec_product.product_name)
        if (!spec_in) {
          query_product.push({
            op_type: o.op_type,
            ...spec_product,
          })
          query_name.push(spec_product.product_name)
        }
        product.push({
          op_type: o.op_type,
          ...spec_product,
        })
        break
      case 'update_qty':
        const qty_product = o?.target_item ?? o?.source_item
        const qty_in = history.item.find(o => o.name === qty_product.product_name)
        if (!qty_in) {
          query_product.push({
            op_type: o.op_type,
            ...qty_product,
          })
          query_name.push(qty_product.product_name)
        }
        product.push({
          op_type: o.op_type,
          ...qty_product,
        })
        break
      case 'replace_product':
        const source_product = o?.source_item
        const source_in = history.item.find(o => o.name === source_product.product_name)
        const target_product = o?.target_item
        const target_in = history.item.find(o => o.name === target_product.product_name)
        if (!source_in) {
          query_product.push({
            op_type: o.op_type,
            target: target_product,
            ...source_product,
          })
          query_name.push(source_product.product_name)
        }
        if (!target_in) {
          query_product.push({
            op_type: o.op_type,
            source: source_product,
            ...target_product,
          })
          query_name.push(target_product.product_name)
        }
        product.push({
          op_type: o.op_type,
          target: target_product,
          ...source_product,
        })
        product.push({
          op_type: o.op_type,
          source: source_product,
          ...target_product,
        })
        break
    }
  })
  let answer = ''
  const item = []
  if (query_product.length === 0) {
    product.forEach(obj => {
      const bill = history.item.find(o => o.name === obj.product_name)
      const option = bill.option
      const size_option = bill.size_option
      const temp_option = bill.temp_option
      let size = normalizeSize(obj.size)
      let temp = normalizeTemperature(obj.temperature)
      let qty = obj.qty
      switch (o.op_type) {
        case 'add':
          qty = obj.qty ?? 1
          break
        case 'delete':
          size = size ?? bill.size
          temp = temp ?? bill.temp
          qty = obj.qty ?? bill.qty
          break
        case 'update_spec':
          qty = obj.qty ?? bill.qty
          break
        case 'update_qty':
          size = size ?? bill.size
          temp = temp ?? bill.temp
          qty = obj.qty ?? 1
          break
        case 'replace_product':
          if (!!obj.target) {
            size = size ?? bill.size
            temp = temp ?? bill.temp
            qty = obj.qty ?? bill.qty
          }
          if (!!obj.source) {
            const source = history.item.find(o => o.name === obj.source.product_name)
            size = size ?? source.size
            temp = temp ?? source.temp
            qty = obj.qty ?? source.qty
          }
          break
      }
      item.push({
        option,
        size_option,
        temp_option,
        id: bill.id,
        name: bill.name,
        qty: obj.qty,
        price: bill.price,
        size,
        temp,
        need_size: size_option.length > 1 && (!size || !size_option.includes(size)),
        need_temp: temp_option.length > 1 && (!temp || !temp_option.includes(temp)),
      })
    })
  }
  return {
    intent,
    product,
    query_product,
    query_name,
  }
}

//#endregion

//#region 处理修改信息

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
function filterProduct(history, product) {
  const product_name = []
  const product_index = {}
  const source_index = {}
  const target_index = {}
  const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
  const item_name = {}
  add_item.forEach(o => item_name[o.name] = o)
  product.forEach(o => {
    if ((!!o.source_name || o.source_name !== 'null') && !item_name[o.source_name]) {
      if (product_index[o.source_name] === undefined) {
        product_index[o.source_name] = product_name.length
        product_name.push(o.source_name)
      }
      source_index[o.source_name] = product_index[o.source_name]
    }
    if ((!!o.target_name || o.target_name !== 'null') && !item_name[o.target_name]) {
      if (product_index[o.target_name] === undefined) {
        product_index[o.target_name] = product_name.length
        product_name.push(o.target_name)
      }
      target_index[o.target_name] = product_index[o.target_name]
    }
  })
  return {
    product_name,
    source_index,
    target_index,
  }
}
function main({text, history}) {
  const obj = handleLLM(text)
  const product = Array.isArray(obj.items) ? Array.from(obj.items) : (!!obj.items ? [obj.items] : [])
  const { product_name, source_index, target_index } = filterProduct(history, product)
  return {
    product,
    product_name,
    source_index,
    target_index,
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
    const error = !!obj.size || !!obj.temp
    let reply = `您已选择${obj.name}${!!obj.size ? '，' + obj.size : ''}${!!obj.temp ? '，' + obj.temp : ''}，但其${error ? '只' : ''}存在`
    if (obj.need_size) {
      reply += `${obj.size_option.length}个容量选项（${obj.size_option.join('、')}），`
    }
    if (obj.need_temp) {
      reply += `${obj.temp_option.length}个温度选项（${obj.temp_option.join('、')}），`
    }
    reply += `请${error ? '重新' : ''}选择。`
    return reply
  }
  const size = obj.size_option.length === 1 && obj.size_option[0] !== obj.size ? obj.size_option[0] : obj.size
  const temp = obj.temp_option.length === 1 && obj.temp_option[0] !== obj.temp ? obj.temp_option[0] : obj.temp
  const price = Number(obj.price) + Number(obj.option[size]) + Number(obj.option[temp])
  const total = price * Number(obj.qty)
  const reply = `${obj.name}${obj.qty}杯，${obj.size}（${size === obj.size ? `可选：${obj.size_option.join('、')}` : `但其只有${size}`}），${obj.temp}（${temp === obj.temp ? `可选：${obj.temp_option.join('、')}` : `但其只有${temp}`}），价格${obj.qty * price}元；\n`
  return { total, reply }
}
function main({text, output, product, history, intent}) {
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
  history?.item?.forEach(o => {
    item_id[o.id] = o
    item_name[o.name] = o
  })
  const by_name = {}
  if (!!output) {
    Array.from(output).forEach(o => by_name[o.product_name] = o)
  }
  let answer = ''
  let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
  if (new_item.length === 0) {
    answer += '目前没有订单可以修改产品，您可以重新点餐或者提问。\n'
  }
  else {
    product.forEach(edit => {
      let source = null
      if (!!item_name[edit.source_name]) {
        source = item_name[edit.source_name]
      }
      else if (!!by_name[edit.source_name]) {
        source = by_name[edit.source_name]
        if (!!item_id[source.id]) {
          source = item_id[source.id]
        }
      }
      let target = null
      if (!!item_name[edit.target_name]) {
        target = item_name[edit.target_name]
      }
      else if (!!by_name[edit.target_name]) {
        target = by_name[edit.target_name]
        if (!!item_id[target.id]) {
          target = item_id[target.id]
        }
      }
      if (!source?.size_option) {
        answer += `目前订单中不存在${edit.source_name}这一产品，请确认。\n`
      }
      const source_name = source?.name
      const target_name = target?.name
      const source_size = normalizeSize(edit.source_size)
      const source_temp = normalizeTemperature(edit.source_temp)
      const target_size = normalizeSize(edit.target_size)
      const target_temp = normalizeTemperature(edit.target_temp)
      const source_qty = Number.isNaN(Number(edit.source_qty)) || edit.source_qty === null ? null : Number(edit.source_qty)
      const target_qty = Number.isNaN(Number(edit.target_qty)) || edit.target_qty === null ? null : Number(edit.target_qty)
      const source_size_option = source?.size_option
      const source_temp_option = source?.temp_option
      if (intent === 'update_spec') {
        const spec_item = new_item.filter(o => o.name === source_name
          && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
          && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
        if (spec_item.length > 1) {
          answer += `目前订单中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
        }
        else if (spec_item.length === 0) {
          answer += `目前订单中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
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
              need_size: size_option.length > 1 && (!size || !size_option.includes(size)),
              need_temp: temp_option.length > 1 && (!temp || !temp_option.includes(temp)),
            })
          }
        }
      }
      else if (intent === 'update_qty') {
        const qty_item = new_item.filter(o => o.name === source_name
          && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
          && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
        if (qty_item.length > 1) {
          answer += `目前订单中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
        }
        else if (qty_item.length === 0) {
          answer += `目前订单中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
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
        }
      }
      else if (intent === 'replace_product') {
        if (!target) {
          answer += `${edit.target_name}没有检索到相关产品，请确认。\n`
        }
        if (!!source && !!target) {
          const option = !!item_name[edit.target_name] ? target.option : option_by_id[target.id] ?? {}
          const format = {}
          const target_size_option = []
          const target_temp_option = []
          Object.keys(option).forEach(o => {
            let key = normalizeSize(o)
            if (!!key) {
              format[key] = option[o]
              target_size_option.push(key)
            } else {
              key = normalizeTemperature(o)
              format[key] = option[o]
              target_temp_option.push(key)
            }
          })
          const replace_item = new_item.filter(o => o.name === source_name
            && (!source_size || source_size === o.size || (source_size_option.length === 1 && source_size === source_size_option[0]))
            && (!source_temp || source_temp === o.temp || (source_temp_option.length === 1 && source_temp === source_temp_option[0])))
          const target_item = new_item.filter(o => o.name === target_name
            && (!target_size || target_size === o.size || (target_size_option.length === 1 && target_size === target_size_option[0]))
            && (!target_temp || target_temp === o.temp || (target_temp_option.length === 1 && target_temp === target_temp_option[0])))
          if (replace_item.length > 1) {
            answer += `目前订单中存在多款${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
          }
          else if (replace_item.length === 0) {
            answer += `目前订单中不存在${edit.source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}这一产品，请确认。\n`
          }
          else if (target_item.length > 1) {
            answer += `目前订单中存在多款${edit.target_name}${!!target_size ? `，${target_size}`: ''}${!!target_temp ? `，${target_temp}`: ''}这一产品，请确认。\n`
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
                      need_size: target_size_option.length > 1 && (!size || !target_size_option.includes(size)),
                      need_temp: target_temp_option.length > 1 && (!temp || !target_temp_option.includes(temp)),
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
                  need_size: target_size_option.length > 1 && (!size || !target_size_option.includes(size)),
                  need_temp: target_temp_option.length > 1 && (!temp || !target_temp_option.includes(temp)),
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
          }
        }
      }
    })
  }
  let new_history = {
    ...history
  }
  if (!answer) {
    const reply = new_item.find(o => o.need_size || o.need_temp) ?? null
    new_history = {
      reply,
      item: new_item,
    }
    if (!!reply) {
      answer += getReply(reply)
    } else {
      let total = 0, reply = ''
      const list = new_item.map(getReply)
      list.forEach(o => {
        reply += o.reply
        total += o.total
      })
      answer += `您已选择以下产品，总价${total}元，您可以选择结账、增改删除产品或者取消：\n`
      answer += reply
    }
  }
  return {
    new_history,
    answer,
  }
}

//#endregion
