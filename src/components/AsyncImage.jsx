/*
Tujuan: Merender gambar lokal/cloud secara aman, termasuk URL idb:// dari IndexedDB.
Caller: Halaman dan modal yang menampilkan foto patroli, insiden, kapal, user, dan onboarding.
Dependensi: React PureComponent dan imageStore IndexedDB.
Main Functions: Resolve source gambar async, tampilkan placeholder loading, dan render fallback saat gagal.
Side Effects: Membaca foto dari IndexedDB lokal tanpa menulis state aplikasi.
*/

import React from 'react';
import { loadImageFromDB } from '../utils/imageStore';

export default class AsyncImage extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      dataUrl: null,
      loading: true,
    };
    this._isMounted = false;
    this._resolveSeq = 0;
  }

  componentDidMount() {
    this._isMounted = true;
    this.resolveSource(this.props.src, this.props.fallbackSrc);
  }

  componentDidUpdate(previousProps) {
    if (previousProps.src !== this.props.src || previousProps.fallbackSrc !== this.props.fallbackSrc) {
      this.resolveSource(this.props.src, this.props.fallbackSrc);
    }
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  // Resolve satu sumber gambar. Mengembalikan data URL final, null bila kosong/gagal,
  // atau langsung mengembalikan URL non-idb apa adanya untuk dipakai sebagai <img src>.
  async resolveSingleSource(src) {
    const safeSrc = typeof src === 'string' ? src : '';
    if (!safeSrc) return null;
    if (!safeSrc.startsWith('idb://')) return safeSrc;
    return loadImageFromDB(safeSrc);
  }

  async resolveSource(src, fallbackSrc) {
    if (!this._isMounted) return;
    const requestSeq = this._resolveSeq + 1;
    this._resolveSeq = requestSeq;

    const isStale = () => (
      !this._isMounted
      || this._resolveSeq !== requestSeq
      || this.props.src !== src
      || this.props.fallbackSrc !== fallbackSrc
    );

    if (typeof src === 'string' && src.startsWith('idb://')) {
      this.setState({ dataUrl: null, loading: true });
    }

    try {
      let result = await this.resolveSingleSource(src);
      // Foto resolusi rendah (thumb/hero) bisa belum tersedia di perangkat ini — mis. record
      // dari device lain yang fotonya hanya tersinkron sebagai URL penuh. Pakai fallbackSrc
      // (umumnya foto penuh) agar gambar tetap tampil alih-alih kosong.
      if (!result && fallbackSrc && fallbackSrc !== src) {
        result = await this.resolveSingleSource(fallbackSrc);
      }
      if (isStale()) return;
      this.setState({ dataUrl: result || null, loading: false });
    } catch (error) {
      console.error('AsyncImage error:', error);
      if (isStale()) return;
      this.setState({ dataUrl: null, loading: false });
    }
  }

  render() {
    const { alt, className, fallbackLayout } = this.props;
    const { dataUrl, loading } = this.state;

    if (loading) {
      return (
        <div className={`animate-pulse bg-cyan-900/30 ${className || ''}`}>
          {fallbackLayout}
        </div>
      );
    }

    if (!dataUrl) {
      return fallbackLayout ? (
        <div className={className || ''}>{fallbackLayout}</div>
      ) : null;
    }

    return <img src={dataUrl} alt={alt || ''} className={className} />;
  }
}
