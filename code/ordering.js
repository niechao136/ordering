
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
  const out_name = {}, check_out = {}
  const in_name = {}, check_in = {}
  const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
  const item_name = {}
  add_item.forEach(o => item_name[o.name] = o)
  product.forEach(o => {
    const name = o?.items?.[0]?.name
    switch (o.op_type) {
      case 'add':
        if (!isNull(name) && !item_name[name] && !check_out[name]) {
          check_out[name] = product_name.length
          out_name[product_name.length] = true
          product_name.push(name)
        }
        break
      case 'delete':
      case 'update_qty':
      case 'update_spec':
        if (!isNull(name) && !item_name[name] && !check_in[name]) {
          check_in[name] = product_name.length
          in_name[product_name.length] = true
          product_name.push(name)
        }
        break
      case 'replace_product':
        const name1 = o?.items?.[1]?.name
        if (!isNull(name) && !item_name[name] && !check_in[name]) {
          check_in[name] = product_name.length
          in_name[product_name.length] = true
          product_name.push(name)
        }
        if (!isNull(name1) && !item_name[name1] && !check_out[name1]) {
          check_out[name1] = product_name.length
          out_name[product_name.length] = true
          product_name.push(name1)
        }
        break
    }
  })
  return {
    product_name,
    in_name,
    out_name,
  }
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
function formatOperations(operation) {
  const res = []
  Array.from(operation).forEach(op => {
    const items = Array.isArray(op?.items) ? Array.from(op.items) : []
    const raw_text = op?.raw_text
    if (['add', 'delete'].includes(op?.op_type) && items.length > 0) {
      items.forEach(item => {
        const { size, temp } = formatSpec(item?.spec)
        const obj = {
          ...(item ?? {}),
          name: !item?.name && items.length === 1 ? raw_text : item?.name,
          size,
          temp,
        }
        res.push({
          ...op,
          items: [obj],
        })
      })
    }
    else if (['update'].includes(op?.op_type) && items.length > 0) {
      if (items.length === 1) {
        const name = items[0]?.name
        const qty = getQty(items[0]?.qty)
        const { size, temp, ns } = formatSpec(items[0]?.spec)
        if (!!ns) {
          res.push({
            op_type: 'replace_product',
            items: [
              {
                name: name,
                qty: null,
                size: null,
                temp: null,
              },
              {
                name: ns,
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else if (!!size || !!temp) {
          res.push({
            op_type: 'update_spec',
            items: [
              {
                name: !!name ? name : raw_text,
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else if (qty !== null) {
          res.push({
            op_type: 'update_qty',
            items: [
              {
                name: !!name ? name : raw_text,
                qty: qty,
                size: size,
                temp: temp,
              },
            ]
          })
        }
        else {
          res.push({
            op_type: 'replace_product',
            items: [
              {
                name: name,
                qty: null,
                size: null,
                temp: null,
              },
              {
                name: ns,
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
        const qty = getQty(items[1]?.qty)
        const qty_s = getQty(items[0]?.qty)
        const nt = items[1]?.name
        const { size: size_s, temp: temp_s} = formatSpec(items[0]?.spec)
        let size = normalizeSize(nt)
        let temp = normalizeTemp(nt)
        if (!!size || !!temp) {
          res.push({
            op_type: 'update_spec',
            items: [
              {
                name: !!name ? name : raw_text,
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
            res.push({
              op_type: 'replace_product',
              items: [
                {
                  name: name,
                  qty: null,
                  size: size_s,
                  temp: temp_s,
                },
                {
                  name: ns,
                  qty: qty,
                  size: size,
                  temp: temp,
                },
              ]
            })
          }
          else if (!!size || !!temp) {
            res.push({
              op_type: 'update_spec',
              items: [
                {
                  name: !!name ? name : raw_text,
                  qty: qty ?? qty_s,
                  size: size,
                  temp: temp,
                },
              ]
            })
          }
          else if (qty !== null || qty_s !== null) {
            res.push({
              op_type: 'update_qty',
              items: [
                {
                  name: !!name ? name : raw_text,
                  qty: qty ?? qty_s,
                  size: size_s,
                  temp: temp_s,
                },
              ]
            })
          }
          else {
            res.push({
              op_type: 'replace_product',
              items: [
                {
                  name: name,
                  qty: null,
                  size: size_s,
                  temp: temp_s,
                },
                {
                  name: ns,
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
          res.push({
            op_type: 'replace_product',
            items: [
              {
                name: name,
                qty: null,
                size: size_s,
                temp: temp_s,
              },
              {
                name: nt,
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
      res.push(op)
    }
  })
  return res
}
function main({text, history, result}) {
  const obj = handleLLM(text)
  let operation = Array.isArray(obj.operation) ? Array.from(obj.operation) : (!isNull(obj?.operation?.op_type) ? [obj.operation] : [])
  let intent, need_checkout = false
  operation = formatOperations(operation)
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
  let product_name = [], in_name = {}, out_name = {}
  if (intent === 'recommend') {
    const items = result.map(o => parseTextToObject(o?.content ?? '')).filter(o => !!o.name)
    if (items.length === 0) {
      dify += '抱歉，未檢索到相關產品，無法進行推薦。'
    }
    else {
      dify += '好的，為您推薦以下產品：\n'
      items.forEach(obj => {
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
    const filter = filterProduct(history, product_items)
    product_name = filter.product_name
    in_name = filter.in_name
    out_name = filter.out_name
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
    in_name,
    out_name,
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
function main({result, item, index, in_name, history}) {
  const kb = parseTextToObject(result[0]?.content ?? '')
  let res = {
    product_name: item,
    ...kb,
  }
  if (in_name[index]) {
    const add_item = Array.isArray(history.item) ? Array.from(history.item) : []
    const item_name = {}
    add_item.forEach(o => item_name[o.name] = o)
    const list = result.map(o => parseTextToObject(o?.content ?? ''))
    let kb = {}
    for (const obj of list) {
      if (!!item_name[obj?.name]) {
        kb = obj
        break
      }
    }
    res = {
      product_name: item,
      ...kb,
    }
  }
  return {
    res,
  }
}

//#endregion
//#region 统一处理点餐商品

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
function main({output, product_items, history, in_name, out_name, need_checkout}) {
  const item_name = {}
  let new_item = Array.isArray(history?.item) ? Array.from(history.item) : []
  new_item.forEach(o => {
    item_name[o.name] = o
  })
  const by_in_name = {}, by_out_name = {}
  if (!!output) {
    Array.from(output).forEach((o, index) => {
      if (in_name[index]) {
        by_in_name[o?.product_name] = o
      }
      else if (out_name[index]) {
        by_out_name[o?.product_name] = o
      }
    })
  }
  const getObj = (name, mode) => {
    const by_name = mode === 'in' ? by_in_name : by_out_name
    const obj = !!item_name[name] ? item_name[name] : (!!item_name[by_name[name]?.name ?? ''] ? item_name[by_name[name].name] : null)
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
    const option = by_name[name]?.option ?? {}
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
        if (!!key) {
          format[key] = option[o]
          temp_option.push(key)
        }
      }
    })
    return {
      obj: by_name[name],
      option: format,
      size_option,
      temp_option,
    }
  }
  let has_error = false
  let product = Array.isArray(history?.product) ? Array.from(history.product) : []
  let dify = ''
  let is_finish = false
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
      if (isNull(name)) {
        dify = '抱歉，無法新增商品，請指定商品名。'
        has_error = true
        break
      }
      if (!item_name[name] && !by_out_name[name]?.name) {
        dify = `抱歉，無法新增商品，${name}未檢索到相關項目`
        has_error = true
        break
      }
      const { obj, option, size_option, temp_option } = getObj(name, 'out')
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
        if (!by_in_name[name]?.name) {
          dify = `抱歉，無法刪除商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_in_name[name]?.name && !item_name[by_in_name[name].name]) {
          dify = `抱歉，無法刪除商品，${name}不在訂單中`
          has_error = true
          break
        }
      }
      const { obj } = getObj(name, 'in')
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
        if (!by_in_name[name]?.name) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_in_name[name]?.name && !item_name[by_in_name[name].name]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中`
          has_error = true
          break
        }
      }
      const { obj } = getObj(name, 'in')
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
        if (!by_in_name[name]?.name) {
          dify = `抱歉，無法修改商品，${name}未檢索到相關項目。`
          has_error = true
          break
        }
        if (!!by_in_name[name]?.name && !item_name[by_in_name[name].name]) {
          dify = `抱歉，無法修改商品，${name}不在訂單中。`
          has_error = true
          break
        }
      }
      const { obj } = getObj(name, 'in')
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
      if (!item_name[source_name]) {
        if (!by_in_name[source_name]?.name) {
          dify = `抱歉，無法替換商品，${source_name}未檢索到相關項目`
          has_error = true
          break
        }
        if (!!by_in_name[source_name]?.name && !item_name[by_in_name[source_name].name]) {
          dify = `抱歉，無法替換商品，${source_name}不在訂單中`
          has_error = true
          break
        }
      }
      if (isNull(target_name)) {
        dify = '抱歉，無法替換商品，請指定替換的商品名。'
        has_error = true
        break
      }
      if (!item_name[target_name] && !by_out_name[target_name]?.name) {
        dify = `抱歉，無法替換商品，${target_name}未檢索到相關項目`
        has_error = true
        break
      }
      const { obj: source_obj } = getObj(source_name, 'in')
      const { obj: target_obj, option: target_option, size_option: target_size_option, temp_option: target_temp_option } = getObj(target_name, 'out')
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
  let new_history = {
    ...history
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
    answer,
    has_error,
    new_history,
  }
}

//#endregion
//#region 整合点餐信息

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
function main({text, history, output, product_items, need_checkout, in_name, out_name}) {
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
  const by_in_name = {}, by_out_name = {}
  if (!!output) {
    Array.from(output).forEach((o, index) => {
      if (in_name[index]) {
        by_in_name[o?.product_name] = o
      }
      else if (out_name[index]) {
        by_out_name[o?.product_name] = o
      }
    })
  }
  const getObj = (name, mode) => {
    const by_name = mode === 'in' ? by_in_name : by_out_name
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
      const { obj, option, size_option, temp_option } = getObj(name, 'out')
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
      const { obj } = getObj(name, 'in')
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
      const { obj } = getObj(name, 'in')
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
        name: name,
        size,
        temp,
        qty: qty ?? 1,
      })
    }
    else if (o.op_type === 'update_spec') {
      const name = o?.items?.[0]?.name
      const { obj } = getObj(name, 'in')
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
        name: name,
        size,
        temp,
        qty,
        qty_o: spec_item[0].qty,
      })
    }
    else if (o.op_type === 'replace_product') {
      const source_name = o?.items?.[0]?.name
      const target_name = o?.items?.[1]?.name
      const { obj: source_obj } = getObj(source_name, 'in')
      const { obj: target_obj, option: target_option, size_option: target_size_option, temp_option: target_temp_option } = getObj(target_name, 'out')
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
        source_name: source_name,
        target_name: target_name,
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
function main({text}) {
  const obj = handleLLM(text)
  const behavior = Array.isArray(obj?.behavior) ? Array.from(obj.behavior)
    : (!!obj?.behavior?.raw_text ? [obj?.behavior] : [])
  const product = ['update_spec', 'update_qty', 'replace_product', 'add', 'delete']
  const list = behavior.filter(o => product.includes(o?.intent) && !!o?.raw_text).map(o => String(o.raw_text))

  return {
    list,
  }
}

function main({result}) {
  const chunk = []
  Array.from(result).forEach(o => {
    const content = o?.metadata?.child_chunks?.[0]?.content ?? ''
    if (content.startsWith('name:')) {
      chunk.push(content.split('name:')[1])
    }
  })
  return {
    chunk,
  }
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
function findBestMatch(query, candidates) {
  const qVec = buildVector(query)

  let best = null
  let bestScore = -1

  for (const text of candidates) {
    const cVec = buildVector(text)
    const score = cosineSimilarity(qVec, cVec)

    if (score > bestScore && score >= 0.4) {
      bestScore = score
      best = text
    }
  }

  return {
    match: best,
    score: bestScore
  };
}
function rankMatches(query, candidates) {
  const qVec = buildVector(query)

  return candidates
    .map(c => ({
      text: c,
      score: cosineSimilarity(qVec, buildVector(c))
    }))
    .sort((a, b) => b.score - a.score)
}
console.log(rankMatches('庄园美式', [
  "莊園級美式",
  "美式黑咖啡",
  "莊園級拿鐵",
  "咖啡拿鐵",
  "風味拿鐵",
  "燕麥拿鐵",
  "莊園老饕深焙",
  "路易莎特調咖啡",
  "澳洲小拿鐵(熱)",
  "鴛鴦咖啡"
]))
