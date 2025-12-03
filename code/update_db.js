
//#region 处理知识库信息

function main({body, body_i}) {
  const res = JSON.parse(body) || {}
  const arr = Array.isArray(res.data) ? Array.from(res.data) : []
  const product = arr.find(o => o.name === 'product.csv')
  const url = !!product ? `/documents/${product.id}/update-by-file` : '/document/create-by-file'
  const res_i = JSON.parse(body_i) || {}
  const data = JSON.stringify({
    name: 'product.csv',
    indexing_technique: res_i.indexing_technique || 'high_quality',
    doc_form: res_i.doc_form || 'hierarchical_model',
    process_rule: {
      mode: 'hierarchical',
      rules: {
        pre_processing_rules: [
          {
            id: 'remove_extra_spaces',
            enabled: false
          },
          {
            id: 'remove_urls_emails',
            enabled: false
          }
        ],
        segmentation: {
          separator: '\n',
          max_tokens: 4000,
          chunk_overlap: 0
        },
        parent_mode: 'paragraph',
        subchunk_segmentation: {
          separator: ';',
          max_tokens: 1000,
          chunk_overlap: 0
        }
      },
      limits: {
        indexing_max_segmentation_tokens_length: 4000
      }
    },
    retrieval_model: res_i.retrieval_model_dict || {
      search_method: 'semantic_search',
      reranking_enable: false,
      reranking_mode: null,
      reranking_model: {
        reranking_provider_name: '',
        reranking_model_name: ''
      },
      weights: null,
      top_k: 5,
      score_threshold_enabled: false,
      score_threshold: null
    },
    embedding_model_provider: res_i.embedding_model_provider || 'langgenius/ollama/ollama',
    embedding_model: res_i.embedding_model || 'quentinz/bge-large-zh-v1.5:latest'
  })
  return {
    url,
    data,
  }
}

//#endregion
//#region 处理数据库结果

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
      obj[key] = String(arr[index]).replaceAll(';', '；').replaceAll(',', '，')
    })
    return obj
  })
}
function toMarkdownTable(arr) {
  if (!arr.length) return ''

  const headers = Object.keys(arr[0])
  const headerRow = `| ${headers.join(' | ')} |`
  const separator = `| ${headers.map(() => '---').join(' | ')} |`

  const rows = arr.map(obj =>
    `| ${headers.map(h => obj[h] ?? '').join(' | ')} |`
  )

  return [headerRow, separator, ...rows].join('\n')
}
function main({text, text_o}) {
  const list = parseMd(text)
  const list_o = parseMd(text_o)
  const option_by_id = {}
  list_o.forEach(o => {
    if (!option_by_id[o.product_id]) {
      option_by_id[o.product_id] = {
        size_option: {},
        temp_option: {},
      }
    }
    if (String(o.name).endsWith('杯')) {
      option_by_id[o.product_id].size_option[o.name] = 1
    } else {
      option_by_id[o.product_id].temp_option[o.name] = 1
    }
  })
  const product = list.map(o => {
    const obj = {}
    if (!!option_by_id[o.id]) {
      obj.size_option = Object.keys(option_by_id[o.id].size_option).join('、')
      obj.temp_option = Object.keys(option_by_id[o.id].temp_option).join('、')
    }
    return {
      ...o,
      ...obj,
    }
  })
  const table = toMarkdownTable(product)
  const name = 'product'
  return {
    table,
    name,
  }
}

//#endregion
//#region Test
//#endregion
