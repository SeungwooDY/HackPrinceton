// Small, curated choices from the existing CoStar model/site mappings.
export const MODEL_CATALOG = [
  { id: 'KBqHB8Xq9Vo', name: '14020 Schroeder Road', detail: 'Unit 141 · Houston, TX', type: 'Residential' },
  { id: 'PLPZJBUixWt', name: '17449–17497 Village Green Drive', detail: 'Houston, TX', type: 'Commercial' },
  { id: 'Ki9YdfpNKum', name: '9117 Richland Drive', detail: 'Houston, TX', type: 'Residential' },
  { id: 'MBnYBa7whdC', name: '450 N Sam Houston Parkway E', detail: 'Houston, TX', type: 'Commercial' },
];

export function parseModelId(value) {
  const input = value.trim();
  if (/^[a-zA-Z0-9]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const id = url.searchParams.get('m') || url.searchParams.get('model');
    return /^[a-zA-Z0-9]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}
