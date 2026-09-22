import { subtotal } from './math.js'

export function checkoutTotal(items, taxRate) {
  return subtotal(items) + taxRate
}
