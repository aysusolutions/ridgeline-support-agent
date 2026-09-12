// Which way is "better" for each comparable attribute. Absent means not comparable.
//
// This is data, deliberately. The comparison tool computes the winner of every dimension
// from this table BEFORE the model sees anything, so a generated comparison cannot claim
// a product is warmer when the numbers say otherwise.
export const DIRECTION = {
  tempRatingC: 'lower',       // a lower rating means a warmer bag
  weightGrams: 'lower',
  packedSize: 'lower',
  priceCents: 'lower',
  waterproofRating: 'higher',
  seasons: 'higher',
  capacity: 'higher',
}

export const LABEL = {
  tempRatingC: 'temperature rating',
  weightGrams: 'weight',
  packedSize: 'packed size',
  waterproofRating: 'waterproofing',
  seasons: 'season rating',
  capacity: 'capacity',
}
