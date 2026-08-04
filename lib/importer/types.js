/**
 * @typedef {Object} ProductRecord
 * @property {string} sku
 * @property {string} barcode
 * @property {string} supplierProductId
 * @property {string} title
 * @property {string} [supplierTitleEn] // título EN oficial do fornecedor (coluna xml_info_otros_idiomas)
 * @property {"supplier"|"pipeline"} [titleSource] // de onde veio `title`
 * @property {string} [titleSourceReason] // porque caiu no pipeline, quando caiu
 * @property {string} description
 * @property {string} category
 * @property {string} categoryMain
 * @property {string[]} categorySegments
 * @property {string[]} franchises
 * @property {string} vendor
 * @property {string} [brand] // alias genérico de vendor
 * @property {number} availableQuantity
 * @property {number} [stock] // alias genérico de availableQuantity
 * @property {boolean} hasStock
 * @property {number|null} [netPrice]
 * @property {number|null} [price] // alias genérico de netPrice
 * @property {number|null} [grossPrice]
 * @property {string} [imageUrl]
 * @property {string} [imageUrlLarge]
 * @property {string[]} [extraImages]
 * @property {number} availability
 * @property {string} [promotionType]
 * @property {Record<string, string>} [_source]
 * @property {Record<string, string>} [_translated]
 */

/**
 * @typedef {Object} ImportFilters
 * @property {string[]} [categoryMain]
 * @property {string[]} [categorySegments]
 * @property {string[]} [brands]
 * @property {string[]} [franchises]
 * @property {boolean} [inStockOnly]
 * @property {string[]} [availability]
 */

export {};
