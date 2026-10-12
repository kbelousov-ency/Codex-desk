export type ProductChannel = 'stable' | 'nightly' | 'experimental3' | 'development';

export function isKuzmichChannel(channel: ProductChannel) {
  return channel === 'nightly' || channel === 'experimental3';
}

export function productNameForChannel(channel: ProductChannel) {
  void channel;
  return 'Кузьмич';
}

export function productNameGenitive(channel: ProductChannel) {
  void channel;
  return 'Кузьмича';
}
