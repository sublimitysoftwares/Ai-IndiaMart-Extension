// Filter-related constants

export const DEFAULT_KEYWORDS = [
  'uniform', 'uniform fabric', 'uniform blazers', 'uniform jackets', 'school jackets', 'nurse uniform',
  'chef coats', 'coat', 'corporate uniform', 'staff uniform', 'ncc uniform', 'waiter uniform',
  'kids school uniform', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
  'worker uniform', 'security guard uniform', 'petrol pump uniform', 'safety suits',
  'boys school uniform', 'girls school uniform', 'surgical gown', 'hospital uniforms'
];

export const DEFAULT_CATEGORIES = [
  'kids school uniform', 'kids school uniforms', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
  'worker uniform', 'uniform fabric', 'security guard uniform', 'petrol pump uniform',
  'safety suits', 'boys school uniform', 'girls school uniform', 'surgical gown', 'hospital uniforms', 'corporate uniform', 'school college uniforms',
  'school jackets'
];

export const DEFAULT_ENQUIRY_KEYWORDS = DEFAULT_KEYWORDS;

export const DEFAULT_ALLOWED_CATEGORIES = DEFAULT_CATEGORIES;

// Complete list of Indian States (28) and Union Territories (8)
export const INDIAN_STATES = [
  // States (28)
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  // Union Territories (8) with alternate spellings
  'Andaman and Nicobar Islands',
  'Andaman & Nicobar Islands',
  'Andaman and Nicobar',
  'Andaman & Nicobar',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Dadra & Nagar Haveli & Daman & Diu',
  'Dadra and Nagar Haveli',
  'Dadra & Nagar Haveli',
  'Daman and Diu',
  'Daman & Diu',
  'Delhi',
  'New Delhi',
  'NCR Delhi',
  'Jammu and Kashmir',
  'Jammu & Kashmir',
  'J&K',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
  'Pondicherry'
];

export const DEFAULT_QUANTITY_THRESHOLD = { min: 20, unit: 'piece' as const };
export const DEFAULT_ORDER_VALUE_MIN = 5000;

export const CONTACT_HISTORY_WINDOW_DAYS = 10;