/**
 * Pre-GraphQL validation for OcioStock product records.
 */

function isValidHttpUrl(url) {
  if (!url?.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {{ syncPrices?: boolean, syncImages?: boolean, requireTitle?: boolean, requirePrice?: boolean }} options
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRecord(record, options = {}) {
  const errors = [];
  const syncPrices = options.syncPrices !== false;
  const requirePrice = options.requirePrice === true || syncPrices;
  const syncImages = options.syncImages === true;
  const requireTitle = options.requireTitle !== false;

  if (!record.sku || !String(record.sku).trim()) {
    errors.push("sku is required");
  } else if (String(record.sku).length > 255) {
    errors.push("sku exceeds 255 characters");
  } else if (/[\x00-\x1f]/.test(record.sku)) {
    errors.push("sku contains invalid characters");
  }

  if (requireTitle && (!record.title || !String(record.title).trim())) {
    errors.push("title is required for live import");
  }

  if (!Number.isFinite(record.availableQuantity) || record.availableQuantity < 0) {
    errors.push("availableQuantity must be >= 0");
  }

  if (requirePrice) {
    const gross = record.grossPrice;
    const net = record.netPrice;
    if (gross != null && gross < 0) errors.push("grossPrice cannot be negative");
    if (net != null && net < 0) errors.push("netPrice cannot be negative");
    if (gross != null && gross <= 0) errors.push("grossPrice must be > 0");
    if (net != null && net <= 0 && (gross == null || gross <= 0)) {
      errors.push("netPrice must be > 0 when grossPrice is missing or <= 0");
    }
    const hasPrice = (gross != null && gross > 0) || (net != null && net > 0);
    if (!hasPrice) {
      errors.push("grossPrice or netPrice must be > 0");
    }
  }

  if (syncImages) {
    const urls = [record.imageUrl, record.imageUrlLarge, ...(record.extraImages || [])].filter(
      Boolean
    );
    if (urls.length === 0) {
      errors.push("imageUrl required when syncImages is enabled");
    } else {
      for (const url of urls) {
        if (!isValidHttpUrl(url)) {
          errors.push(`invalid image URL: ${url.slice(0, 80)}`);
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * @param {import('../types.js').ProductRecord[]} records
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 * @param {object} options
 * @returns {import('../types.js').ProductRecord[]}
 */
export function validateAndFilterRecords(records, job, options = {}) {
  const valid = [];
  for (const record of records) {
    const { valid: ok, errors } = validateRecord(record, options);
    if (ok) {
      valid.push(record);
    } else {
      job.recordValidationSkipped({
        sku: record.sku || "(unknown)",
        errors,
      });
    }
  }
  return valid;
}
