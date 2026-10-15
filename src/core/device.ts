// What kind of device the game runs on.

/** A phone or tablet: the main pointer is a finger. These get lighter assets (less memory). */
export const isTouchDevice = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
