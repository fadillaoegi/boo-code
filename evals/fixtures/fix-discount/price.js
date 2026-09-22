export function discountedPrice(price, percent) {
  if (price < 0 || percent < 0 || percent > 100) throw new RangeError('invalid price or discount')
  return price - percent
}
