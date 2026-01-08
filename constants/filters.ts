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

export const INDIAN_STATES = [
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
  'Delhi',
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
  'West Bengal'
];

export const DEFAULT_QUANTITY_THRESHOLD = { min: 20, unit: 'piece' as const };
export const DEFAULT_ORDER_VALUE_MIN = 5000;

export const CONTACT_HISTORY_WINDOW_DAYS = 10;