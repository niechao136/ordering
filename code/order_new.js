//#region 处理检索结果

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
//#region 处理意图识别和商品提取

function handleLLM(text) {
  const regex = /```json([\s\S]*?)```/
  const _res = text.replaceAll(/<think>[\s\S]*?<\/think>/g, '')
  const match = _res.match(regex)
  const res = match ? match[1].trim() : _res

  // 更安全的注释移除，不会误删 URL 与字符串内容
  const str = res
    .replace(/\/\/(?!\s*http)[^\n]*/g, '')       // 去掉行注释，但保留 https://
    .replace(/\/\*[\s\S]*?\*\//g, '');           // 块注释

  let obj
  try {
    obj = JSON.parse(str)
  } catch (e) {
    obj = {}
  }
  return obj
}
function isNull(value) {
  return !value || value === 'null'
}
function ngram(text, n) {
  const grams = []
  for (let i = 0; i <= text.length - n; i++) {
    grams.push(text.slice(i, i + n))
  }
  return grams
}
function buildVector(text) {
  const vec = {}
  const grams2 = ngram(text, 2)
  const grams3 = ngram(text, 3)
  for (const g of grams2) {
    vec[g] = (vec[g] || 0) + 1
  }
  for (const g of grams3) {
    vec[g] = (vec[g] || 0) + 1.5 // 3-gram 权重更高
  }
  return vec
}
function cosineSimilarity(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const k in a) {
    const v = a[k]
    normA += v * v
    if (b[k]) {
      dot += v * b[k]
    }
  }
  for (const k in b) {
    const v = b[k]
    normB += v * v
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
function parseTextToObject(text) {
  const result = {}
  // 按行拆分，过滤空行
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean)

  for (const line of lines) {
    // 只按第一个冒号切割
    const idx = line.indexOf(":")
    if (idx === -1) continue

    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()

    // 处理 option 字段
    if (key === "option" && value.startsWith("[") && value.endsWith("]")) {
      const optionText = value.slice(1, -1) // 去掉 []
      const optionObj = {}

      optionText.split(";").forEach(item => {
        if (!item) return
        const splitIndex = item.indexOf(":")
        if (splitIndex === -1) return

        const optKey = item.slice(0, splitIndex).trim()
        const optValue = item.slice(splitIndex + 1).trim()

        optionObj[optKey] = isNaN(optValue) ? optValue : Number(optValue)
      })

      result[key] = optionObj
      continue
    }

    // 普通字段：数字自动转 number
    result[key] = isNaN(Number(value)) ? value : Number(value)
  }

  return result
}
function normalizeSize(size) {
  if (!size) return null
  const text = String(size).trim().toLowerCase()
  // 大杯
  if (/(大杯|large|big|\bl\b)/i.test(text)) return '大杯'
  // 中杯
  if (/(中杯|medium|mid|\bm\b)/i.test(text)) return '中杯'
  return null
}
function normalizeTemp(temp) {
  if (!temp) return null
  const text = String(temp).trim().toLowerCase()
  // 冰的
  if (/(冰|冷|iced|ice|cold)/i.test(text)) return '冰的'
  // 热的
  if (/(热|熱|warm|hot)/i.test(text)) return '熱的'
  return null
}
function getOption(obj = {}) {
  const option = {}
  const size_option = []
  const temp_option = []
  Object.keys(obj).forEach(o => {
    let key = normalizeSize(o)
    if (!!key) {
      option[key] = obj[o]
      size_option.push(key)
    } else {
      key = normalizeTemp(o)
      if (!!key) {
        option[key] = obj[o]
        temp_option.push(key)
      }
    }
  })
  return {
    option,
    size_option,
    temp_option,
  }
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
function formatSpec(spec) {
  let size = null, temp = null, ns = null
  const list = Array.isArray(spec) ? Array.from(spec) : []
  for (const str of list) {
    const s = normalizeSize(str)
    if (!!s) {
      size = s
    } else {
      const t = normalizeTemp(str)
      if (!!t) {
        temp = t
      } else {
        ns = str
      }
    }
  }
  return {
    size,
    temp,
    ns,
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
function handleOperation(text, result) {
  const obj = handleLLM(text)
  const operate = Array.isArray(obj.operation) ? Array.from(obj.operation) : (!isNull(obj?.operation?.op_type) ? [obj.operation] : [])
  const product = [], item_name = {}
  Array.from(result).forEach(o => {
    const content = o?.metadata?.child_chunks?.[0]?.content ?? ''
    if (content.startsWith('name:')) {
      const obj = parseTextToObject(o?.content ?? '')
      if (!!obj?.name) {
        product.push(obj)
        item_name[obj.name] = obj
      }
    }
  })
  function handleProduct(nm, pd, rt, len) {
    const name = !nm && len === 1 ? rt : nm
    let prod = item_name[pd] ?? null
    if (!prod?.name && operate.length === 1 && len === 1) {
      prod = product[0] ?? null
    }
    if (!prod?.name) {
      const qVec = buildVector(pd ?? '')
      let max = 0
      product.forEach(o => {
        const score = cosineSimilarity(qVec, buildVector(o.name))
        if (score > 0 && score > max) {
          max = score
          prod = o
        }
      })
      if (!prod?.name) {
        const qVec = buildVector(name ?? '')
        let max = 0
        product.forEach(o => {
          const score = cosineSimilarity(qVec, buildVector(o.name))
          if (score > 0 && score > max) {
            max = score
            prod = o
          }
        })
      }
    }
    return {
      name,
      product: prod,
    }
  }
  const operation = []
  operate.forEach(op => {
    const items = Array.isArray(op?.items) ? Array.from(op.items) : []
    const raw_text = op?.raw_text
    if (['add', 'delete'].includes(op?.op_type) && items.length > 0) {
      items.forEach(item => {
        const { size, temp } = formatSpec(item?.spec)
        const obj = {
          ...(item ?? {}),
          ...handleProduct(item?.name, item?.product, raw_text, items.length),
          size,
          temp,
        }
        operation.push({
          ...op,
          items: [obj],
        })
      })
    }
    else if (['update'].includes(op?.op_type) && items.length > 0) {
      if (items.length === 1) {
        const name = items[0]?.name
        const prod = items[0]?.product
        const qty = getQty(items[0]?.qty)
        const { size, temp, ns } = formatSpec(items[0]?.spec)
        if (!!ns) {
          operation.push({
            op_type: 'replace_product',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 2),
                qty: null,
                size: null,
                temp: null,
              },
              {
                ...handleProduct(ns, ns, raw_text, 2),
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else if (!!size || !!temp) {
          operation.push({
            op_type: 'update_spec',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 1),
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else if (qty !== null) {
          operation.push({
            op_type: 'update_qty',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 1),
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else {
          operation.push({
            op_type: 'replace_product',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 2),
                qty: null,
                size: null,
                temp: null,
              },
              {
                ...handleProduct(ns, ns, raw_text, 2),
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
      }
      else {
        const name = items[0]?.name
        const prod = items[0]?.product
        const qty = getQty(items[1]?.qty)
        const qty_s = getQty(items[0]?.qty)
        const nt = items[1]?.name
        const pt = items[1]?.product
        const { size: size_s, temp: temp_s} = formatSpec(items[0]?.spec)
        let size = normalizeSize(nt)
        let temp = normalizeTemp(nt)
        if (!!size || !!temp) {
          operation.push({
            op_type: 'update_spec',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 1),
                qty: qty ?? qty_s,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else if (!nt) {
          const { size, temp, ns } = formatSpec(items[1]?.spec)
          if (!!ns) {
            operation.push({
              op_type: 'replace_product',
              items: [
                {
                  ...handleProduct(name, prod, raw_text, 2),
                  qty: null,
                  size: size_s,
                  temp: temp_s,
                },
                {
                  ...handleProduct(ns, pt, raw_text, 2),
                  qty: qty,
                  size: size,
                  temp: temp,
                },
              ]
            })
          }
          else if (!!size || !!temp) {
            operation.push({
              op_type: 'update_spec',
              items: [
                {
                  ...handleProduct(name, prod, raw_text, 1),
                  qty: qty ?? qty_s,
                  size: size,
                  temp: temp,
                },
              ]
            })
          }
          else if (qty !== null || qty_s !== null) {
            operation.push({
              op_type: 'update_qty',
              items: [
                {
                  ...handleProduct(name, prod, raw_text, 1),
                  qty: qty ?? qty_s,
                  size: size_s,
                  temp: temp_s,
                },
              ]
            })
          }
          else {
            operation.push({
              op_type: 'replace_product',
              items: [
                {
                  ...handleProduct(name, prod, raw_text, 2),
                  qty: null,
                  size: size_s,
                  temp: temp_s,
                },
                {
                  ...handleProduct(ns, pt, raw_text, 2),
                  qty: qty,
                  size: size,
                  temp: temp,
                },
              ]
            })
          }
        }
        else {
          const { size, temp } = formatSpec(items[1]?.spec)
          operation.push({
            op_type: 'replace_product',
            items: [
              {
                ...handleProduct(name, prod, raw_text, 2),
                qty: null,
                size: size_s,
                temp: temp_s,
              },
              {
                ...handleProduct(nt, pt, raw_text, 2),
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
      }
    }
    else {
      operation.push(op)
    }
  })
  return {
    operation,
    product,
  }
}
function handleIntent(operation) {
  let intent, checkout = false
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
        checkout = true
        break
      }
    }
    if (product_items.length === 0 && checkout) {
      intent = 'checkout'
    }
    else if (product_items.length > 0) {
      intent = 'product'
    }
    else {
      intent = 'none'
    }
  }
  return {
    intent,
    checkout,
    product_items,
  }
}
function handleAnswer(history, intent, product_items, list, checkout) {
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
  let new_history = {
    ...history
  }
  if (intent === 'recommend') {
    if (list.length === 0) {
      dify += '抱歉，未檢索到相關產品，無法進行推薦。'
    }
    else {
      dify += '好的，為您推薦以下產品：\n'
      list.forEach(obj => {
        const { option, size_option, temp_option } = getOption(obj.option)
        const add = Object.keys(option).filter(k => option[k] > 0)
        let add_text = add.length > 0 ? `，其中：${add.map(o => `${o}+${option[o]}元`)}` : ''
        dify += `${obj.name}，可選容量：${size_option.join('、')}，可選溫度：${temp_option.join('、')}，單價：${obj.price}元${add_text}；\n`
      })
    }
  }
  else if (intent === 'cancel') {
    if (!!history?.item) {
      dify = '好的，已為您取消訂單，您可以重新點餐或提問。'
      product = []
      new_history = {}
    } else {
      dify = '抱歉，目前沒有訂單可以取消，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'checkout') {
    if (!!history?.item) {
      dify = '好的，已為您開啟結帳流程。'
      is_finish = true
      new_history = {}
    } else {
      dify = '抱歉，目前沒有訂單可以結帳，您可以重新點餐或提問。'
    }
  }
  else if (intent === 'product') {
    const item_name = {}
    let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
    new_item.forEach(o => {
      item_name[o.name] = o
    })
    let has_error = false
    const success = {
      add: [],
      delete: [],
      update_qty: [],
      update_spec: [],
      replace_product: [],
    }
    for (const op of product_items) {
      if (op.op_type === 'add') {
        const name = op?.items?.[0]?.name
        const prod = op?.items?.[0]?.product
        if (isNull(name)) {
          dify = '抱歉，無法新增商品，請指定商品名。'
          has_error = true
          break
        }
        if (!item_name[name] && isNull(prod)) {
          dify = `抱歉，無法新增商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        const obj = !!item_name[name] ? item_name[name] : prod
        const { option, size_option, temp_option } = !!item_name[name] ? item_name[name] : getOption(prod?.option)
        const qty = getQty(op?.items?.[0]?.qty)
        const size = getSize(op?.items?.[0], size_option)
        const temp = getTemp(op?.items?.[0], temp_option)
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
      else if (op.op_type === 'delete') {
        const name = op?.items?.[0]?.name
        const prod = op?.items?.[0]?.product
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
        if (!item_name[name] && isNull(prod)) {
          dify = `抱歉，無法刪除商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!item_name[name] && !item_name[prod?.name]) {
          dify = `抱歉，無法刪除商品，${name}不在訂單中`
          has_error = true
          break
        }
        const obj = !!item_name[name] ? item_name[name] : prod
        const qty = getQty(op?.items?.[0]?.qty)
        const size = normalizeSize(op?.items?.[0]?.size)
        const temp = normalizeTemp(op?.items?.[0]?.temp)
        const del_item = new_item.filter(o => o.name === obj.name && (!size || size === o.size) && (!temp || temp === o.temp))
        if (del_item.length > 1) {
          dify = `抱歉，無法刪除商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`
          has_error = true
          break
        }
        if (del_item.length === 0) {
          dify = `抱歉，無法刪除商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`
          has_error = true
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
      else if (op.op_type === 'update_qty') {
        const name = op?.items?.[0]?.name
        const prod = op?.items?.[0]?.product
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
        if (!item_name[name] && isNull(prod)) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!item_name[name] && !item_name[prod?.name]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中`
          has_error = true
          break
        }
        const obj = !!item_name[name] ? item_name[name] : prod
        const qty = getQty(op?.items?.[0]?.qty)
        const size = normalizeSize(op?.items?.[0]?.size)
        const temp = normalizeTemp(op?.items?.[0]?.temp)
        const qty_item = new_item.filter(o => o.name === obj.name && (!size || size === o.size) && (!temp || temp === o.temp))
        if (qty_item.length > 1) {
          dify = `抱歉，無法修改商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`
          has_error = true
          break
        }
        if (qty_item.length === 0) {
          dify = `抱歉，無法修改商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`
          has_error = true
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
          name: name,
          size,
          temp,
          qty: qty ?? 1,
        })
      }
      else if (op.op_type === 'update_spec') {
        const name = op?.items?.[0]?.name
        const prod = op?.items?.[0]?.product
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
        if (!item_name[name] && isNull(prod)) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!item_name[name] && !item_name[prod?.name]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中`
          has_error = true
          break
        }
        const obj = !!item_name[name] ? item_name[name] : prod
        const qty = getQty(op?.items?.[0]?.qty)
        const size = normalizeSize(op?.items?.[0]?.size)
        const temp = normalizeTemp(op?.items?.[0]?.temp)
        const spec_item = new_item.filter(o => o.name === obj.name)
        if (spec_item.length > 1) {
          dify = `抱歉，無法修改商品，訂單中存在多款${name}。`
          has_error = true
          break
        }
        if (spec_item.length === 0) {
          dify = `抱歉，無法修改商品，${name}不在訂單中。`
          has_error = true
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
            name: spec_item[0].name,
            qty: qty ?? 1,
            price: spec_item[0].price,
            size: size ?? spec_item[0].size,
            temp: temp ?? spec_item[0].temp,
          })
        }
        success.update_spec.push({
          name: name,
          size,
          temp,
          qty,
          qty_o: spec_item[0].qty,
        })
      }
      else if (op.op_type === 'replace_product') {
        const source_name = op?.items?.[0]?.name
        const target_name = op?.items?.[1]?.name
        const source_prod = op?.items?.[0]?.product
        const target_prod = op?.items?.[1]?.product
        if (!history?.item) {
          dify = '抱歉，目前沒有訂單可以替換商品，您可以重新點餐或提問。'
          has_error = true
          break
        }
        if (isNull(source_name)) {
          dify = '抱歉，無法替換商品，請指定被替換的商品名。'
          has_error = true
          break
        }
        if (!item_name[source_name] && isNull(source_prod)) {
          dify = `抱歉，無法替換商品，${source_name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!item_name[source_name] && !item_name[source_prod?.name]) {
          dify = `抱歉，無法替換商品，${source_name}未檢索到相關項目`
          has_error = true
          break
        }
        if (isNull(target_name)) {
          dify = '抱歉，無法替換商品，請指定替換的商品名。'
          has_error = true
          break
        }
        if (!item_name[target_name] && isNull(target_prod)) {
          dify = `抱歉，無法替換商品，${target_name}未檢索到相關項目`
          has_error = true
          break
        }
        const source_obj = !!item_name[source_name] ? item_name[source_name] : source_prod
        const target_obj = !!item_name[target_name] ? item_name[target_name] : target_prod
        const { option: target_option, size_option: target_size_option, temp_option: target_temp_option } = !!item_name[target_name] ? item_name[target_name] : getOption(target_prod?.option)
        const source_size = normalizeSize(op?.items?.[0]?.size)
        const source_temp = normalizeTemp(op?.items?.[0]?.temp)
        const target_size = normalizeSize(op?.items?.[1]?.size)
        const target_temp = normalizeTemp(op?.items?.[1]?.temp)
        const target_qty = getQty(op?.items?.[1]?.qty)
        const source_item = new_item.filter(o => o.name === source_obj.name && (!source_size || source_size === o.size) && (!source_temp || source_temp === o.temp))
        const target_item = new_item.filter(o => o.name === target_obj.name && (!target_size || target_size === o.size) && (!target_temp || target_temp === o.temp))
        if (source_item.length > 1) {
          dify = `抱歉，無法替換商品，訂單中存在多款${source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}。`
          has_error = true
          break
        }
        if (source_item.length === 0) {
          dify = `抱歉，無法替換商品，${source_name}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}不在訂單中。`
          has_error = true
          break
        }
        if (target_item.length > 1) {
          dify = `抱歉，無法替換商品，訂單中存在多款${target_name}${!!target_size ? `，${target_size}`: ''}${!!target_temp ? `，${target_temp}`: ''}。`
          has_error = true
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
                  name: target_obj.name,
                  qty: source_item[0].qty,
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
          source_name: source_name,
          target_name: target_name,
          qty,
          qty_o: source_item[0].qty,
        })
      }
    }
    if (!has_error) {
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
      if (checkout) {
        is_finish = true
        dify += '並為您開啟結帳流程。'
        new_history = {}
      }
    }
  }
  const answer = {
    dify,
    is_finish,
    product,
  }
  return {
    answer,
    new_history,
  }
}
function main({text, history, result}) {
  const { operation, product } = handleOperation(text, result)
  const { intent, product_items, checkout } = handleIntent(operation)
  const { answer, new_history } = handleAnswer(history, intent, product_items, product, checkout)
  return {
    answer,
    new_history,
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
//#region Test
//#endregion

function handleLLM(text = '') {
  const str = text.replaceAll(/<think>[\s\S]*?<\/think>/g, '')
  const match = str.match(/```json([\s\S]*?)```/)?.[1] ?? str
  const json = match.replace(/\/\/(?!\s*http)[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  try {
    return JSON.parse(json)
  } catch (e) {
    return {}
  }
}
function parseTextToObject(text = '') {
  const result = {}
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (key === "option" && value.startsWith("[") && value.endsWith("]")) {
      const optionText = value.slice(1, -1) // 去掉 []
      const optionObj = {}
      optionText.split(";").forEach(item => {
        if (!item) return
        const splitIndex = item.indexOf(":")
        if (splitIndex === -1) return
        const optKey = item.slice(0, splitIndex).trim()
        const optValue = item.slice(splitIndex + 1).trim()
        optionObj[optKey] = isNaN(optValue) ? optValue : Number(optValue)
      })
      result[key] = optionObj
      continue
    }
    result[key] = isNaN(Number(value)) ? value : Number(value)
  }
  return result
}
function isNull(value) {
  return !value || value === 'null'
}
function ngram(text = '', n = 2) {
  const grams = []
  for (let i = 0; i <= text.length - n; i++) {
    grams.push(text.slice(i, i + n))
  }
  return grams
}
function buildVector(text = '') {
  const vec = {}
  const grams2 = ngram(text, 2)
  const grams3 = ngram(text, 3)
  for (const g of grams2) {
    vec[g] = (vec[g] || 0) + 1
  }
  for (const g of grams3) {
    vec[g] = (vec[g] || 0) + 1.5 // 3-gram 权重更高
  }
  return vec
}
function cosineSimilarity(a = {}, b = {}) {
  let dot = 0, normA = 0, normB = 0
  for (const k in a) {
    normA += a[k] * a[k]
    if (b[k]) {
      dot += a[k] * b[k]
    }
  }
  for (const k in b) {
    normB += b[k] * b[k]
  }
  return !normA || !normB ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
function normalizeSize(size = '') {
  if (!size) return null
  const text = String(size).trim().toLowerCase()
  if (/(大杯|large|big|\bl\b)/i.test(text)) return '大杯'
  if (/(中杯|medium|mid|\bm\b)/i.test(text)) return '中杯'
  return null
}
function normalizeTemp(temp = '') {
  if (!temp) return null
  const text = String(temp).trim().toLowerCase()
  if (/(冰|冷|iced|ice|cold)/i.test(text)) return '冰的'
  if (/(热|熱|warm|hot)/i.test(text)) return '熱的'
  return null
}
function getOption(obj = {}) {
  const option = {}, size_option = [], temp_option = []
  Object.keys(obj).forEach(o => {
    const size = normalizeSize(o)
    const temp = normalizeTemp(o)
    if (!!size) {
      option[size] = obj[o]
      size_option.push(size)
    } else if (!!temp) {
      option[temp] = obj[o]
      temp_option.push(temp)
    }
  })
  return { option, size_option, temp_option }
}
function getValue(obj = {}, option = [], prop = 'size') {
  const format = prop === 'size' ? normalizeSize(obj[prop]) : (prop === 'temp' ? normalizeTemp(obj[prop]) : '')
  const word = prop === 'size' ? '中杯' : (prop === 'temp' ? normalizeTemp(obj.name) ?? '冰的' : '')
  const def = option.find(o => o === word) ?? option[0]
  return !!format && option.includes(format) ? format : def
}
function getQty(qty) {
  return isNull(qty) || Number.isNaN(Number(qty)) ? null : Number(qty)
}
function formatSpec(spec) {
  let size = null, temp = null, ns = null
  const list = Array.isArray(spec) ? Array.from(spec) : []
  for (const str of list) {
    const s = normalizeSize(str)
    const t = normalizeTemp(str)
    if (!!s) size = s
    else if (!!t) temp = t
    else ns = str
  }
  return { size, temp, ns }
}
function getProduct(item) {
  const res = []
  const product = Array.isArray(item) ? Array.from(item) : []
  product.forEach(o => {
    const size = !!o.size ? o.size : o.size_option[0]
    const temp = !!o.temp ? o.temp : o.temp_option[0]
    for (let i = 0; i < o.qty; i++) {
      res.push({
        name: o.name,
        price: o.price,
        options: [
          { name: size, price: o.option[size] },
          { name: temp, price: o.option[temp] },
        ]
      })
    }
  })
  return res
}
function handleOperation(text, result) {
  const obj = handleLLM(text)
  const operate = Array.isArray(obj.operation) ? Array.from(obj.operation) : (!isNull(obj?.operation?.op_type) ? [obj.operation] : [])
  const product = [], item_name = {}
  Array.from(result).forEach(o => {
    const content = o?.metadata?.child_chunks?.[0]?.content ?? ''
    if (content.startsWith('name:')) {
      const obj = parseTextToObject(o?.content ?? '')
      if (!!obj?.name) {
        product.push(obj)
        item_name[obj.name] = obj
      }
    }
  })
  function getItem(nm, pd, sp, qt, rt, len) {
    const name = !nm && len === 1 ? rt : nm
    const { size, temp } = formatSpec(sp)
    const qty = getQty(qt)
    let prod = item_name[pd] ?? null
    if (!prod?.name && operate.length === 1 && len === 1) {
      prod = product[0] ?? null
    }
    if (!prod?.name) {
      const qVec = buildVector(pd ?? '')
      let max = 0
      product.forEach(o => {
        const score = cosineSimilarity(qVec, buildVector(o.name))
        if (score > 0 && score > max) {
          max = score
          prod = o
        }
      })
      if (!prod?.name) {
        const qVec = buildVector(name ?? '')
        let max = 0
        product.forEach(o => {
          const score = cosineSimilarity(qVec, buildVector(o.name))
          if (score > 0 && score > max) {
            max = score
            prod = o
          }
        })
      }
    }
    return { name, product: prod, qty, size, temp }
  }
  const operation = []
  operate.forEach(op => {
    const items = Array.isArray(op?.items) ? Array.from(op.items) : []
    const raw_text = op?.raw_text
    if (['add', 'delete'].includes(op?.op_type) && items.length > 0) {
      items.forEach(item => {
        operation.push({
          ...op,
          items: [getItem(item?.name, item?.product, item?.spec, item?.qty, raw_text, items.length)],
        })
      })
    } else if (['update'].includes(op?.op_type) && items.length > 0) {
      if (items.length === 1) {
        const { name, qty, spec, product: prod } = items[0] ?? {}
        const { size, temp, ns } = formatSpec(spec)
        let op_type, list = [getItem(name, prod, spec, qty, raw_text, 1)]
        if (!!ns) {
          op_type = 'replace_product'
          list = [getItem(name, prod, null, null, raw_text, 2), getItem(ns, ns, spec, qty, raw_text, 2)]
        } else if (!!size || !!temp) {
          op_type = 'update_spec'
        } else if (qty !== null) {
          op_type = 'update_qty'
        } else {
          op_type = 'replace_product'
          list = [getItem(name, prod, null, null, raw_text, 2), getItem(ns, ns, spec, qty, raw_text, 2)]
        }
        operation.push({ op_type, items: list })
      } else {
        const { name, qty, spec, product: prod } = items[0] ?? {}
        const { name: nt, qty: qt, spec: sp, product: pt } = items[1] ?? {}
        const num = getQty(qt) ?? getQty(qty)
        let op_type, list
        const { size, temp} = formatSpec([nt])
        if (!!size || !!temp) {
          op_type = 'update_spec'
          list = [getItem(name, prod, [nt], num, raw_text, 1)]
        }
        else if (!nt) {
          const { size, temp, ns } = formatSpec(sp)
          if (!!ns) {
            op_type = 'replace_product'
            list = [getItem(name, prod, spec, null, raw_text, 2), getItem(ns, pt, sp, qt, raw_text, 2)]
          }
          else if (!!size || !!temp) {
            op_type = 'update_spec'
            list = [getItem(name, prod, sp, num, raw_text, 1)]
          }
          else if (num !== null) {
            op_type = 'update_qty'
            list = [getItem(name, prod, spec, num, raw_text, 1)]
          }
          else {
            op_type = 'replace_product'
            list = [getItem(name, prod, spec, null, raw_text, 2), getItem(ns, pt, sp, qt, raw_text, 2)]
          }
        }
        else {
          op_type = 'replace_product'
          list = [getItem(name, prod, spec, null, raw_text, 2), getItem(nt, pt, sp, qt, raw_text, 2)]
        }
        operation.push({ op_type, items: list })
      }
    } else {
      operation.push(op)
    }
  })
  return { operation, product }
}
function handleIntent(operation) {
  let intent, checkout = false
  const product_items = []
  const product_op = ['add', 'delete', 'update_qty', 'update_spec', 'replace_product']
  const op_type = product_op.concat(['recommend', 'checkout', 'cancel', 'none'])
  const op = operation.filter(o => op_type.includes(o.op_type))
  if (op.length === 0 || op.every(o => o.op_type === 'none')) {
    intent = 'none'
  } else if (!!op.find(o => o.op_type === 'recommend')) {
    intent = 'recommend'
  } else if (!!op.find(o => o.op_type === 'cancel')) {
    intent = 'cancel'
  } else if (op.every(o => o.op_type === 'checkout')) {
    intent = 'checkout'
  } else {
    for (const o of op) {
      if (product_op.includes(o.op_type)) {
        product_items.push(o)
      }
      if (o.op_type === 'checkout') {
        checkout = true
        break
      }
    }
    if (product_items.length === 0 && checkout) {
      intent = 'checkout'
    } else if (product_items.length > 0) {
      intent = 'product'
    } else {
      intent = 'none'
    }
  }
  return {
    intent,
    checkout,
    product_items,
  }
}
function createOrderContext(history) {
  const items = Array.isArray(history?.item) ? [...history.item] : []
  return {
    items,
    itemMap: Object.fromEntries(items.map(o => [o.name, o])),
    error: null,
    success: {
      add: [],
      delete: [],
      update_qty: [],
      update_spec: [],
      replace_product: [],
    },
    fail(msg) {
      this.error = msg
    },
    hasError() {
      return !!this.error
    },
  }
}
function handleAdd(ctx, op) {
  const name = op?.items?.[0]?.name
  const prod = op?.items?.[0]?.product
  if (isNull(name)) return ctx.fail('抱歉，無法新增商品，請指定商品名。')
  if (!ctx.itemMap[name] && !prod) return ctx.fail(`抱歉，無法新增商品，${name}未檢索到相關項目`)
  const base = ctx.itemMap[name] ?? prod
  const { option, size_option, temp_option } = ctx.itemMap[name] ?? getOption(prod.option)
  const qty = getQty(op?.items?.[0].qty) ?? 1
  const size = getValue(op?.items?.[0], size_option, 'size')
  const temp = getValue(op?.items?.[0], temp_option, 'temp')
  const exist = ctx.items.find(o => o.name === base.name && o.size === size && o.temp === temp)
  if (exist) exist.qty += qty
  else ctx.items.push({option, size_option, temp_option, name: base.name, qty, price: base.price, size, temp})
  ctx.success.add.push({ name: base.name, size, temp, qty })
}
function handleDelete(ctx, op) {
  const name = op?.items?.[0]?.name
  const prod = op?.items?.[0]?.product
  if (!ctx.items.length) return ctx.fail('抱歉，目前沒有訂單可以刪除商品，您可以重新點餐或提問。')
  if (isNull(name)) return ctx.fail('抱歉，無法刪除商品，請指定商品名。')
  if (!ctx.itemMap[name] && !prod) return ctx.fail(`抱歉，無法刪除商品，${name}未檢索到相關項目`)
  const obj = ctx.itemMap[name] ?? prod
  const size = normalizeSize(op?.items?.[0]?.size)
  const temp = normalizeTemp(op?.items?.[0]?.temp)
  const qty = getQty(op?.items?.[0]?.qty)
  const exist = Array.from(ctx.items).filter(o => o.name === obj.name && (!size || o.size === size) && (!temp || o.temp === temp))
  if (exist.length > 1) return ctx.fail(`抱歉，無法刪除商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`)
  if (exist.length === 0) return ctx.fail(`抱歉，無法刪除商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`)
  if (!qty || qty >= exist[0].qty) ctx.items = ctx.items.filter(o => o !== exist[0])
  else exist[0].qty -= qty
  ctx.success.delete.push({name: obj.name, size, temp, qty, qty_o: exist[0].qty})
}
function handleUpdateQty(ctx, op) {
  const name = op?.items?.[0]?.name
  const prod = op?.items?.[0]?.product
  if (!ctx.items.length) return ctx.fail('抱歉，目前沒有訂單可以修改商品，您可以重新點餐或提問。')
  if (isNull(name)) return ctx.fail('抱歉，無法修改商品，請指定商品名。')
  if (!ctx.itemMap[name] && !prod) return ctx.fail(`抱歉，無法修改商品，${name}未檢索到相關項目`)
  const obj = ctx.itemMap[name] ?? prod
  const size = normalizeSize(op?.items?.[0]?.size)
  const temp = normalizeTemp(op?.items?.[0]?.temp)
  const qty = getQty(op?.items?.[0]?.qty) ?? 1
  const exist = Array.from(ctx.items).filter(o => o.name === obj.name && (!size || o.size === size) && (!temp || o.temp === temp))
  if (exist.length > 1) return ctx.fail(`抱歉，無法修改商品，訂單中存在多款${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}。`)
  if (exist.length === 0) return ctx.fail(`抱歉，無法修改商品，${name}${!!size ? `，${size}`: ''}${!!temp ? `，${temp}`: ''}不在訂單中。`)
  exist[0].qty = qty
  ctx.success.update_qty.push({ name: obj.name, size, temp, qty })
}
function handleUpdateSpec(ctx, op) {
  const name = op?.items?.[0]?.name
  const prod = op?.items?.[0]?.product
  if (!ctx.items.length) return ctx.fail('抱歉，目前沒有訂單可以修改商品，您可以重新點餐或提問。')
  if (isNull(name)) return ctx.fail('抱歉，無法修改商品，請指定商品名。')
  if (!ctx.itemMap[name] && !prod) return ctx.fail(`抱歉，無法修改商品，${name}未檢索到相關項目`)
  const obj = ctx.itemMap[name] ?? prod
  const size = normalizeSize(op?.items?.[0]?.size)
  const temp = normalizeTemp(op?.items?.[0]?.temp)
  const qty = getQty(op?.items?.[0]?.qty)
  const exist = Array.from(ctx.items).filter(o => o.name === obj.name)
  if (exist.length > 1) return ctx.fail(`抱歉，無法修改商品，訂單中存在多款${name}。`)
  if (exist.length === 0) return ctx.fail(`抱歉，無法修改商品，${name}不在訂單中。`)
  if (!qty || qty >= exist[0].qty) {
    exist[0].size = size ?? exist[0].size
    exist[0].temp = temp ?? exist[0].temp
  } else {
    exist[0].qty -= qty
    ctx.items.push({
      ...exist[0],
      qty,
      size: size ?? exist[0].size,
      temp: temp ?? exist[0].temp,
    })
  }
  ctx.success.update_spec.push({name: obj.name, size, temp, qty, qty_o: exist[0].qty})
}
function handleReplaceProduct(ctx, op) {
  const sourceName = op?.items?.[0]?.name
  const targetName = op?.items?.[1]?.name
  const sourceProd = op?.items?.[0]?.product
  const targetProd = op?.items?.[1]?.product
  if (!ctx.items.length) return ctx.fail('抱歉，目前沒有訂單可以替換商品，您可以重新點餐或提問。')
  if (isNull(sourceName)) return ctx.fail('抱歉，無法替換商品，請指定被替換的商品名。')
  if (isNull(targetName)) return ctx.fail('抱歉，無法替換商品，請指定替換的商品名。')
  const sourceObj = ctx.itemMap[sourceName] ?? sourceProd
  const targetObj = ctx.itemMap[targetName] ?? targetProd
  if (!sourceObj) return ctx.fail(`抱歉，無法替換商品，${sourceName}未檢索到相關項目`)
  if (!targetObj) return ctx.fail(`抱歉，無法替換商品，${targetName}未檢索到相關項目`)
  const source_size = normalizeSize(op?.items?.[0]?.size)
  const source_temp = normalizeTemp(op?.items?.[0]?.temp)
  const source_exist = Array.from(ctx.items).filter(o => o.name === sourceObj.name && (!source_size || o.size === source_size) && (!source_temp || o.temp === source_temp))
  if (source_exist.length > 1) return ctx.fail(`抱歉，無法替換商品，訂單中存在多款${sourceName}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}。`)
  if (source_exist.length === 0) return ctx.fail(`抱歉，無法替換商品，${sourceName}${!!source_size ? `，${source_size}`: ''}${!!source_temp ? `，${source_temp}`: ''}不在訂單中。`)
  const target_size = normalizeSize(op?.items?.[1]?.size)
  const target_temp = normalizeTemp(op?.items?.[1]?.temp)
  const target_exist = Array.from(ctx.items).filter(o => o.name === targetObj.name && (!target_size || o.size === target_size) && (!target_temp || o.temp === target_temp))
  if (target_exist.length > 1) return ctx.fail(`抱歉，無法替換商品，訂單中存在多款${targetName}${!!target_size ? `，${target_size}`: ''}${!!target_temp ? `，${target_temp}`: ''}。`)
  const qty = getQty(op?.items?.[1]?.qty)
  const size = target_size ?? source_exist[0].size
  const temp = target_temp ?? source_exist[0].temp
  const { option, size_option, temp_option } = !!ctx.itemMap[targetName] ? ctx.itemMap[targetName] : getOption(targetProd?.option)
  if (!qty || qty >= source_exist[0].qty) ctx.items = ctx.items.filter(o => o !== source_exist[0])
  else source_exist[0].qty -= qty
  const target_qty = (!qty || qty >= source_exist[0].qty) ? source_exist[0].qty : qty
  if (target_exist.length > 0) target_exist[0].qty += target_qty
  else ctx.items.push({option, size_option, temp_option, name: targetObj.name, qty: target_qty, price: targetObj.price, size, temp})
  ctx.success.replace_product.push({source_name: sourceObj.name, target_name: targetObj.name, qty, qty_o: source_exist[0].qty})
}
function handleAnswer(history, operation, list) {
  const { intent, checkout, product_items} = handleIntent(operation)
  const OP_HANDLERS = {
    add: handleAdd,
    delete: handleDelete,
    update_qty: handleUpdateQty,
    update_spec: handleUpdateSpec,
    replace_product: handleReplaceProduct,
  }
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = '', is_finish = false, new_history = { ...history }
  if (intent === 'recommend') {
    dify += (list.length === 0 ? '抱歉，未檢索到相關產品，無法進行推薦。' : '好的，為您推薦以下產品：\n')
    dify += Array.from(list).map(obj => {
      const { option, size_option, temp_option } = getOption(obj.option)
      const add = Object.keys(option).filter(k => option[k] > 0)
      const add_text = add.length > 0 ? `，其中：${add.map(o => `${o}+${option[o]}元`)}` : ''
      return `${obj.name}，可選容量：${size_option.join('、')}，可選溫度：${temp_option.join('、')}，單價：${obj.price}元${add_text}；`
    }).join('\n')
  } else if (intent === 'cancel') {
    if (!!history?.item) {
      dify = '好的，已為您取消訂單，您可以重新點餐或提問。'
      product = []
      new_history = {}
    } else {
      dify = '抱歉，目前沒有訂單可以取消，您可以重新點餐或提問。'
    }
  } else if (intent === 'checkout') {
    if (!!history?.item) {
      dify = '好的，已為您開啟結帳流程。'
      is_finish = true
      new_history = {}
    } else {
      dify = '抱歉，目前沒有訂單可以結帳，您可以重新點餐或提問。'
    }
  } else if (intent === 'product') {
    const ctx = createOrderContext(history)
    for (const op of product_items) {
      OP_HANDLERS[op.op_type]?.(ctx, op)
      if (ctx.hasError()) break
    }
    if (ctx.hasError()) {
      dify = ctx.error
    } else {
      product = getProduct(ctx.items)
      new_history = {
        item: ctx.items,
        product,
      }
      dify = '好的，'
      if (ctx.success.add.length > 0) dify += '已為您添加'
      dify += ctx.success.add.map(o => `${o.qty}杯${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}；`).join('')
      if (ctx.success.delete.length > 0) dify += '已為您刪除'
      dify += ctx.success.delete.map(o => `${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}；`).join('')
      dify += ctx.success.update_qty.map(o => `已將${o.name}${!!o.size ? `，${o.size}`: ''}${!!o.temp ? `，${o.temp}`: ''}改為${o.qty ?? 1}杯；`).join('')
      dify += ctx.success.update_spec.map(o => `已將${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.name}改為${!!o.size ? `${o.size}`: ''}${!!o.temp ? `${o.temp}`: ''}；`).join('')
      dify += ctx.success.replace_product.map(o => `已將${!o.qty ? '' : `${o.qty >= o.qty_o ? o.qty_o : o.qty}杯`}${o.source_name}替換為${o.target_name}；`).join('')
      if (checkout) {
        is_finish = true
        dify += '並為您開啟結帳流程。'
        new_history = {}
      }
    }
  }
  const answer = {dify, is_finish, product}
  return { intent, answer, new_history }
}
function main({text, history, result}) {
  const { operation, product } = handleOperation(text, result)
  const { answer, intent, new_history } = handleAnswer(history, operation, product)
  return { answer, intent, new_history }
}
console.log(main({
  "text": "```json\n{\n  \"operation\": [\n    {\n      \"raw_text\": \"庄园美式改成庄园拿铁\",\n      \"op_type\": \"update\",\n      \"items\": [\n        {\n          \"name\": \"庄园美式\",\n          \"qty\": null,\n          \"spec\": [],\n          \"product\": \"莊園級美式\"\n        },\n        {\n          \"name\": \"庄园拿铁\",\n          \"qty\": null,\n          \"spec\": [],\n          \"product\": \"莊園級拿鐵\"\n        }\n      ]\n    }\n  ]\n}\n```",
  "history": {
    "item": [
      {
        "name": "莊園級美式",
        "option": {
          "中杯": 0,
          "冰的": 0,
          "大杯": 20,
          "熱的": 0
        },
        "price": 60,
        "qty": 1,
        "size": "大杯",
        "size_option": [
          "中杯",
          "大杯"
        ],
        "temp": "冰的",
        "temp_option": [
          "冰的",
          "熱的"
        ]
      }
    ],
    "product": [
      {
        "name": "莊園級美式",
        "options": [
          {
            "name": "大杯",
            "price": 20
          },
          {
            "name": "冰的",
            "price": 0
          }
        ],
        "price": 60
      }
    ]
  },
  "result": [
    {
      "content": "name:莊園級美式\ndescription:中杯正常冰, 熱-總糖量:0, 總熱量:15.5大卡｜大杯正常冰, 熱-總糖量:0, 總熱量:23.2大卡｜中杯, 大杯-咖啡因含量:紅201mg/杯以上。咖啡豆產地：巴西, 衣索比亞, 哥倫比亞, 薩爾瓦多\nprice:60\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:莊園級美式",
            "id": "87d3ab8f-4502-4188-bd0a-4c7f8248935d",
            "position": 1,
            "score": 0.6747249204171447
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 1,
        "retriever_from": "workflow",
        "score": 0.6747249204171447,
        "segment_hit_count": 335,
        "segment_id": "ded0343c-9209-49b0-bd70-dd5324db0432",
        "segment_index_node_hash": "51c9df964e9e588e639f4bd8bdf0276155260f904c1355a18567e57530849991",
        "segment_position": 1,
        "segment_word_count": 166
      },
      "title": "product.md"
    },
    {
      "content": "name:美式黑咖啡\ndescription:大杯正常冰-總糖量:0, 總熱量:23.5大卡｜咖啡因含量:紅201mg/杯以上。;大杯熱-總糖量:0, 總熱量:23.5大卡｜咖啡因含量:紅201mg/杯以上。;中杯正常冰-總糖量:0, 總熱量:15.7大卡｜咖啡因含量:黃101-200mg/杯。;中杯熱-總糖量:0, 總熱量:15.7大卡｜咖啡因含量:黃101-200mg/杯。\nprice:50\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:美式黑咖啡",
            "id": "d9d2083e-b88c-41fd-8e70-f246eaa9eea7",
            "position": 1,
            "score": 0.6016125727684782
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 2,
        "retriever_from": "workflow",
        "score": 0.6016125727684782,
        "segment_hit_count": 317,
        "segment_id": "4aa2e7db-c8ab-404a-ba7b-abc8bc1b3d01",
        "segment_index_node_hash": "01b85c9eb798c4f2623fa9d50a89881611589822d9bdd87ca5d042dd88384d91",
        "segment_position": 22,
        "segment_word_count": 229
      },
      "title": "product.md"
    },
    {
      "content": "name:莊園級拿鐵\ndescription:中杯正常冰-總糖量:39.6公克, 總熱量:267.7大卡｜中杯熱-總糖量:25.1公克, 總熱量:214.3大卡｜大杯正常冰-總糖量:54.4公克, 總熱量:381.5大卡｜大杯熱-總糖量:33.6公克, 總熱量:290大卡｜中杯, 大杯-咖啡因含量:紅201mg/杯以上｜奶泡經由外送過程而消泡屬正常現象。咖啡豆產地：巴西, 衣索比亞, 哥倫比亞, 薩爾瓦多\nprice:80\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:莊園級拿鐵",
            "id": "a1df026c-c467-4803-a406-29ee688f886b",
            "position": 1,
            "score": 0.5046141028404235
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 3,
        "retriever_from": "workflow",
        "score": 0.5046141028404235,
        "segment_hit_count": 390,
        "segment_id": "d20edd55-3294-44ec-9707-5d6b0d1de3d8",
        "segment_index_node_hash": "a49b8215d551ab68287e3d2a1535fef5e89587c3d548fad0cf05ace27b928361",
        "segment_position": 2,
        "segment_word_count": 243
      },
      "title": "product.md"
    },
    {
      "content": "name:咖啡拿鐵\ndescription:中杯正常冰-總糖量:39.6公克, 總熱量:267.9大卡, 中杯熱-總糖量:25.1公克, 總熱量:214.5大卡, 大杯正常冰-中杯正常冰-總糖量:39.6公克, 總熱量:267.9大卡｜中杯熱-總糖量:25.1公克, 總熱量:214.5大卡｜大杯正常冰-總糖量:54.4公克, 總熱量:381.8大卡｜大杯熱-總糖量:33.6公克, 總熱量:290.2大卡｜中杯-咖啡因含量:黃101-200mg/杯｜大杯-咖啡因含量:紅201mg/杯以上｜奶泡經由外送過程而消泡屬正常現象。咖啡豆產地：巴西, 衣索比亞, 印尼\nprice:70\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:咖啡拿鐵",
            "id": "73ee1729-47e8-48b2-a1a9-de4d0bce4357",
            "position": 1,
            "score": 0.4129487454891205
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 4,
        "retriever_from": "workflow",
        "score": 0.4129487454891205,
        "segment_hit_count": 302,
        "segment_id": "149f760a-a7df-4af6-9825-e5460951f38e",
        "segment_index_node_hash": "d1a3cd065abb1f4654709739c1f735fe00537fa7cbadf255681b1d7a3895ab81",
        "segment_position": 14,
        "segment_word_count": 320
      },
      "title": "product.md"
    },
    {
      "content": "name:莊園老饕深焙\ndescription:中杯 Medium｜中杯正常冰-總熱量:4大卡｜中杯熱-總熱量:7.2大卡｜總糖量:0｜咖啡因含量:黃101-200mg/杯｜糖包1包4公克糖, 所含熱量16大卡。咖啡豆產地：尼加拉瓜, 瓜地馬拉, 印尼, 肯亞\nprice:85\noption:[中杯:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:莊園老饕深焙",
            "id": "76e7fb1c-1cae-4c21-b781-495acf52c77e",
            "position": 1,
            "score": 0.398563152551651
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 5,
        "retriever_from": "workflow",
        "score": 0.398563152551651,
        "segment_hit_count": 336,
        "segment_id": "c7ca65f0-343b-4577-bde2-a5af36a66358",
        "segment_index_node_hash": "8c1cdf7b72a4eafa3e1ed16c5b5a2c5280d2d436269f4bd5decd421de149459e",
        "segment_position": 11,
        "segment_word_count": 158
      },
      "title": "product.md"
    },
    {
      "content": "name:風味拿鐵\ndescription:中杯正常冰-總糖量:27.5公克, 總熱量:223.2大卡｜ 中杯熱-總糖量:18公克, 總熱量:207.1大卡｜ 大杯正常冰-總糖量:37.24公克, 總熱量:319.9大卡｜ 大杯熱-總糖量:23.8公克, 總熱量:273.1大卡｜ 中杯-咖啡因含量:黃101-200mg/杯｜ 大杯-咖啡因含量:紅201mg/杯以上｜ 奶泡經由外送過程而消泡屬正常現象。咖啡豆產地：巴西, 衣索比亞, 印尼\nprice:80\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:風味拿鐵",
            "id": "6d8c0214-279e-4909-9c75-ac87588085ef",
            "position": 1,
            "score": 0.39497336745262146
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 6,
        "retriever_from": "workflow",
        "score": 0.39497336745262146,
        "segment_hit_count": 238,
        "segment_id": "1cc07620-cd6b-4c06-847f-a8e8e7ec7fec",
        "segment_index_node_hash": "1b3a601d6f24a4092a9342b2073ec32b2e4421edb0bfad5d99cbf9b6e3631756",
        "segment_position": 17,
        "segment_word_count": 259
      },
      "title": "product.md"
    },
    {
      "content": "name:燕麥拿鐵\ndescription:中杯正常冰-總糖量:27.5公克, 總熱量:223.2大卡｜ 中杯熱-總糖量:18公克, 總熱量:207.1大卡｜ 大杯正常冰-總糖量:37.24公克, 總熱量:319.9大卡｜ 大杯熱-總糖量:23.8公克, 總熱量:273.1大卡｜ 中杯-咖啡因含量:黃101-200mg/杯｜ 大杯-咖啡因含量:紅201mg/杯以上｜ 奶泡經由外送過程而消泡屬正常現象。咖啡豆產地：巴西, 衣索比亞, 印尼\nprice:75\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:燕麥拿鐵",
            "id": "8630102b-ee0d-475b-a55f-9575eb2ccecb",
            "position": 1,
            "score": 0.381579327583313
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 7,
        "retriever_from": "workflow",
        "score": 0.381579327583313,
        "segment_hit_count": 242,
        "segment_id": "0b2248dd-cda2-44cb-9acd-cee9f160931a",
        "segment_index_node_hash": "15a3f13eae99d4bc20d832dd4b7729ef2775da28567a82eabd3719dfca2d5836",
        "segment_position": 16,
        "segment_word_count": 259
      },
      "title": "product.md"
    },
    {
      "content": "name:路易莎特調咖啡\ndescription:中杯正常冰-總糖量:32.8公克, 總熱量:248.6大卡｜中杯熱-總糖量:22.8公克, 總熱量:208.6大卡｜大杯正常冰-總糖量:44.7公克, 總熱量:375大卡｜大杯熱-總糖量:29.7公克, 總熱量:315大卡｜中杯-咖啡因含量:黃101-200mg/杯｜大杯-咖啡因含量:紅201mg/杯以上。咖啡豆產地：巴西, 衣索比亞, 印尼\nprice:60\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:路易莎特調咖啡",
            "id": "71613f6a-7fa1-481f-b942-63c9601320af",
            "position": 1,
            "score": 0.3494170844554901
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 8,
        "retriever_from": "workflow",
        "score": 0.3494170844554901,
        "segment_hit_count": 332,
        "segment_id": "61462b23-a519-4eb8-b860-7d2cc5fe22b2",
        "segment_index_node_hash": "8edaa06299ee18251a9c6f452b12bda2f97df17a033b938c330bb50cf7505b49",
        "segment_position": 20,
        "segment_word_count": 236
      },
      "title": "product.md"
    },
    {
      "content": "name:澳洲小拿鐵(熱)\ndescription:熱飲｜8oz熱-總糖量:8.5公克, 總熱量:125.1大卡｜咖啡因含量:黃101-200mg/杯｜奶泡經由外送過程而消泡屬正常現象｜糖包1包4公克糖, 所含熱量16大卡。咖啡豆產地：巴西, 衣索比亞, 哥倫比亞, 薩爾瓦多\nprice:60\noption:[中杯:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:澳洲小拿鐵(熱)",
            "id": "73a3ca5e-f1c6-4d35-9a0c-633b4ae00e10",
            "position": 1,
            "score": 0.3214539527893066
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 9,
        "retriever_from": "workflow",
        "score": 0.3214539527893066,
        "segment_hit_count": 214,
        "segment_id": "3da13e03-84c7-4ed9-bfea-7e057dab8ef0",
        "segment_index_node_hash": "3498ff31093234b05ab5c183afbbe67bb2b6ff9c6b159c8bb962a9e78ae2feb9",
        "segment_position": 3,
        "segment_word_count": 166
      },
      "title": "product.md"
    },
    {
      "content": "name:鴛鴦咖啡\ndescription:中杯正常冰-總糖量:34.4公克, 總熱量:231.3大卡｜中杯熱-總糖量:24.4公克, 總熱量:191.3大卡｜大杯正常冰-總糖量:47公克, 總熱量:356.2大卡｜大杯熱-總糖量:32公克, 總熱量:296.2大卡｜中杯-咖啡因含量:綠100mg/杯以下｜大杯-咖啡因含量:黃101-200mg/杯｜茶葉產地:英國｜奶泡經由外送過程而消泡屬正常現象。咖啡豆產地：巴西, 衣索比亞, 印尼\nprice:60\noption:[中杯:0;大杯:20;冰的:0;熱的:0]",
      "files": null,
      "metadata": {
        "_source": "knowledge",
        "child_chunks": [
          {
            "content": "name:鴛鴦咖啡",
            "id": "81d52cc3-ff95-4153-b6f5-2688fcea6192",
            "position": 1,
            "score": 0.3106357395648956
          }
        ],
        "data_source_type": "upload_file",
        "dataset_id": "1222c9d3-08f9-4166-8a18-7dd252da9484",
        "dataset_name": "Ordering知识库",
        "doc_metadata": null,
        "document_id": "bdb5f92b-22d9-4c0b-b4c6-19cd55399f82",
        "document_name": "product.md",
        "position": 10,
        "retriever_from": "workflow",
        "score": 0.3106357395648956,
        "segment_hit_count": 299,
        "segment_id": "efe96f81-2070-40bc-8bc0-47af04027086",
        "segment_index_node_hash": "9535514eccda0c70221ef83d4bc7422a883cabc3db64e8c8b9d89c0e1c041031",
        "segment_position": 21,
        "segment_word_count": 258
      },
      "title": "product.md"
    }
  ]
}))
