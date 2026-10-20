/*
Tujuan: Menyajikan form login Supabase Auth dan registrasi publik terisolasi SmartPatrol SQL.
Caller: App shell saat belum ada sesi user operasional aktif.
Dependensi: Auth context runtime, ikon Lucide, dan AsyncImage untuk foto onboarding.
Main Functions: Login user operasional, kirim registrasi publik, upload foto profil onboarding, dan
                masuk dengan akun demo (petugas/admin, data dummy tidak disimpan).
Side Effects: Memicu handler auth/register context serta menyimpan foto onboarding ke state form.
*/

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AppContextRuntime';
import { Shield, Ship, Eye, EyeOff, Camera, AlertTriangle, X, UserCog, UserRound, FlaskConical } from 'lucide-react';
import { DEMO_ACCOUNTS, enterDemoMode, exitDemoMode, isDemoMode } from '../services/demoMode';
import { acknowledgeLatestAutoLogout, readAutoLogoutLog } from '../utils/autoLogoutLog';
import AsyncImage from '../components/AsyncImage';

const DEMO_ACCOUNT_ICONS = { petugas: UserRound, admin: UserCog };

// Pilihan masuk dengan akun dummy. Aplikasi dimuat ulang ke mode demo: tanpa Supabase dan tanpa
// menyimpan data apa pun, sehingga aman dipakai untuk mencoba alur.
function DemoAccountPicker() {
  if (isDemoMode) {
    return (
      <div className="mt-6 p-4 rounded-2xl border border-fuchsia-500/40 bg-fuchsia-500/5 space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-fuchsia-300 flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5" /> Mode Demo Aktif</p>
        <p className="text-[11px] text-cyan-300">Login akun asli tidak tersedia di mode demo.</p>
        <button type="button" onClick={exitDemoMode} className="w-full py-3 rounded-xl border border-cyan-700 text-cyan-200 hover:bg-cyan-900/30 transition-all">
          <span className="text-xs font-black uppercase tracking-widest">Kembali ke Login Biasa</span>
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-5 border-t border-cyan-900/50 space-y-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-fuchsia-300 flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5" /> Masuk dengan Akun Demo</p>
        <p className="text-[11px] text-cyan-600 mt-1">Memakai data dummy, tidak membaca atau menulis data server, dan tidak disimpan — semua perubahan hilang saat keluar atau muat ulang.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Object.values(DEMO_ACCOUNTS).map((account) => {
          const Icon = DEMO_ACCOUNT_ICONS[account.key] || UserRound;
          return (
            <button
              key={account.key}
              type="button"
              onClick={() => enterDemoMode(account.key)}
              className="p-3 rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/5 hover:bg-fuchsia-500/15 text-left transition-all"
              aria-label={`Masuk sebagai ${account.label}`}
            >
              <Icon className="w-5 h-5 text-fuchsia-300 mb-1.5" />
              <span className="block text-xs font-black text-fuchsia-100">{account.label}</span>
              <span className="block text-[10px] text-cyan-600 mt-0.5">{account.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatAutoLogoutTime(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
}

export default function LoginPage() {
  const { authMode, setAuthMode, authBusy, authError, setAuthError, authNotice, setAuthNotice, authForm, setAuthForm, handleLogin, handleRegister, handleAuthPhotoUpload } = useAuth();
  // Alasan logout otomatis terakhir (diagnostik "mental logout sendiri"); disembunyikan setelah ditutup.
  const [latestAutoLogout, setLatestAutoLogout] = useState(() => {
    const [latestEntry] = readAutoLogoutLog();
    return latestEntry && !latestEntry.acknowledged ? latestEntry : null;
  });
  // Tandai sudah dilihat begitu tampil agar tidak muncul lagi di login berikutnya.
  useEffect(() => { acknowledgeLatestAutoLogout(); }, []);
  const dismissAutoLogout = () => setLatestAutoLogout(null);

  const [showPassword, setShowPassword] = React.useState(false);
  const [invalidFields, setInvalidFields] = React.useState({});

  // Reset local invalid fields highlight when switching between login and register
  React.useEffect(() => {
    setInvalidFields({});
    setAuthError('');
    setAuthNotice('');
  }, [authMode, setAuthError, setAuthNotice]);

  // Clear photo highlight once photo is uploaded
  React.useEffect(() => {
    if (authForm.photoUrl && invalidFields.photo) {
      setInvalidFields(prev => ({ ...prev, photo: false }));
    }
  }, [authForm.photoUrl, invalidFields.photo]);

  const formatPhone = (val) => {
    const clean = val.replace(/\D/g, ''); // Ambil hanya digit
    const match = clean.slice(0, 17); // Batasi maksimal 17 digit (4+4+4+5)
    const parts = [];
    if (match.length > 0) parts.push(match.slice(0, 4));
    if (match.length > 4) parts.push(match.slice(4, 8));
    if (match.length > 8) parts.push(match.slice(8, 12));
    if (match.length > 12) parts.push(match.slice(12, 17));
    return parts.join('-');
  };

  const handlePhoneChange = (e) => {
    const formatted = formatPhone(e.target.value);
    setAuthForm(prev => ({ ...prev, phone: formatted }));
    if (invalidFields.phone) {
      setInvalidFields(prev => ({ ...prev, phone: false }));
    }
  };

  const handleFieldChange = (field, value) => {
    setAuthForm(prev => ({ ...prev, [field]: value }));
    if (invalidFields[field]) {
      setInvalidFields(prev => ({ ...prev, [field]: false }));
    }
  };

  const getInputClass = (fieldName) => {
    const base = "w-full bg-[#0b1229] rounded-xl p-3.5 text-sm text-cyan-50 outline-none shadow-sm transition-all";
    if (authMode === 'register' && invalidFields[fieldName]) {
      return `${base} border border-rose-500 bg-rose-500/5 shadow-[0_0_10px_rgba(244,63,94,0.25)]`;
    }
    return `${base} border border-cyan-800/50 focus:border-cyan-400`;
  };

  const onSubmitRegister = async (e) => {
    if (e && e.preventDefault) e.preventDefault();

    setAuthError('');
    setAuthNotice('');

    const errors = {};

    // 1. Validasi Foto
    if (!authForm.photoUrl) {
      errors.photo = true;
    }

    // 2. Validasi Nama
    if (!authForm.name || !authForm.name.trim()) {
      errors.name = true;
    }

    // 3. Validasi Nomor Pekerja
    if (!authForm.workerNumber || !authForm.workerNumber.trim()) {
      errors.workerNumber = true;
    }

    // 4. Validasi Format Email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!authForm.email || !authForm.email.trim() || !emailRegex.test(authForm.email)) {
      errors.email = true;
    }

    // 5. Validasi Password
    if (!authForm.password || authForm.password.length < 8) {
      errors.password = true;
    }

    // 6. Validasi Konfirmasi Password
    if (!authForm.confirmPassword || authForm.confirmPassword !== authForm.password) {
      errors.confirmPassword = true;
    }

    // 7. Validasi Nomor Telepon
    const rawPhone = (authForm.phone || '').replace(/\D/g, '');
    const isPhoneValid = rawPhone.length >= 10 && rawPhone.length <= 17;
    if (!authForm.phone || !authForm.phone.trim() || !isPhoneValid) {
      errors.phone = true;
    }

    setInvalidFields(errors);

    if (Object.keys(errors).length > 0) {
      if (errors.photo) {
        setAuthError('Foto profil wajib diambil/diunggah.');
      } else if (errors.name) {
        setAuthError('Nama lengkap wajib diisi.');
      } else if (errors.workerNumber) {
        setAuthError('Nomor pekerja wajib diisi.');
      } else if (errors.email) {
        setAuthError('Format email tidak valid (contoh: nama@domain.com).');
      } else if (errors.password) {
        setAuthError('Password wajib diisi dan minimal 8 karakter.');
      } else if (errors.confirmPassword) {
        setAuthError('Konfirmasi password tidak cocok.');
      } else if (errors.phone) {
        setAuthError('Nomor telepon tidak valid (minimal 10 digit, auto format xxxx-xxxx-xxxx-xxxxx).');
      } else {
        setAuthError('Harap isi semua kolom dengan benar.');
      }
      return;
    }

    await handleRegister();
  };

  return (
    <div style={{ fontFamily: '"Chakra Petch", sans-serif' }} className="w-full min-h-screen bg-[#070b19] text-cyan-50 sm:max-w-md sm:mx-auto sm:border-x sm:border-cyan-900/50 sm:shadow-[0_0_40px_rgba(6,182,212,0.1)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.12),_transparent_42%),radial-gradient(circle_at_bottom,_rgba(250,204,21,0.08),_transparent_35%)]"></div>
      <div className={`relative min-h-screen flex flex-col px-5 py-8 ${authMode === 'register' ? 'justify-start' : 'justify-center'}`}>
        <div className="mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <Shield className="w-16 h-16 text-cyan-300 stroke-[1.5] opacity-20 absolute" />
              <Shield className="w-16 h-16 text-cyan-300 stroke-1 absolute" />
              <Ship className="w-8 h-8 text-cyan-300 relative z-10 drop-shadow-[0_0_15px_rgba(34,211,238,0.4)]" />
            </div>
            <div>
              <p className="text-[10px] text-cyan-500 font-bold uppercase tracking-[0.35em]">SMARTPATROL BY ANTISLEK</p>
              <h1 className="text-3xl font-black text-white leading-none mt-1">Akses Sistem</h1>
              <p className="text-sm text-cyan-500 leading-relaxed mt-2">Aplikasi Pintar Untuk membantu Petugas Patroli</p>
            </div>
          </div>
        </div>

        {latestAutoLogout && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/40 rounded-xl text-xs text-amber-200" role="alert">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-black uppercase tracking-widest text-[10px] text-amber-400">Anda keluar otomatis</p>
                <p className="font-medium mt-1">{latestAutoLogout.message}</p>
                <p className="text-[10px] text-amber-300/70 mt-1">Kode: {latestAutoLogout.code} · {formatAutoLogoutTime(latestAutoLogout.at)}</p>
              </div>
              <button type="button" onClick={dismissAutoLogout} className="p-1 text-amber-400/80 hover:text-amber-200" aria-label="Tutup pemberitahuan"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}
        {authNotice && authNotice !== latestAutoLogout?.message && <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 font-medium">{authNotice}</div>}
        {authError && <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300 font-medium">{authError}</div>}

        <div className="space-y-3.5">
          <div className="flex bg-[#0b1229] p-1 rounded-xl border border-cyan-800/50">
            <button onClick={() => { setAuthMode('login'); }} className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${authMode === 'login' ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30' : 'text-cyan-700 hover:text-cyan-500'}`}>Login</button>
            <button onClick={() => { setAuthMode('register'); }} className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${authMode === 'register' ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30' : 'text-cyan-700 hover:text-cyan-500'}`}>Register</button>
          </div>

          {authMode === 'register' && (
            <>
              <div className="flex flex-col items-center mb-2">
                {!authForm.photoUrl ? (
                  <button onClick={handleAuthPhotoUpload} className={`w-24 h-24 rounded-2xl border-2 border-dashed ${invalidFields.photo ? 'border-rose-500 bg-rose-500/5 shadow-[0_0_10px_rgba(244,63,94,0.25)] text-rose-500' : 'border-cyan-500/50 bg-[#070b19] text-cyan-500 hover:text-cyan-300 hover:border-cyan-400'} flex flex-col items-center justify-center transition-colors shadow-sm`}>
                    <Camera className="w-6 h-6 mb-1" />
                    <span className="text-[9px] font-bold">FOTO</span>
                  </button>
                ) : (
                  <div className="relative w-24 h-24 rounded-2xl overflow-hidden border-2 border-cyan-500 shadow-md">
                    <AsyncImage src={authForm.photoUrl} alt="Foto profil registrasi" className="w-full h-full object-cover" />
                    <button onClick={() => setAuthForm({ ...authForm, photoUrl: null })} className="absolute bottom-0 inset-x-0 bg-rose-500/90 py-1 text-[9px] text-white font-bold hover:bg-rose-600 transition-colors">
                      HAPUS
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Nama Lengkap</label>
                <input type="text" value={authForm.name} onChange={e => handleFieldChange('name', e.target.value)} placeholder="Masukkan nama lengkap" className={getInputClass('name')} />
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                Registrasi publik hanya membuat akun Supabase Auth dan profil onboarding terbatas. Role, assignment, dan akses operasional akan ditentukan admin setelah approval.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Instansi</label>
                  <select value={authForm.type} onChange={e => handleFieldChange('type', e.target.value)} className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none appearance-none shadow-sm">
                    <option value="BUJP">BUJP</option>
                    <option value="TNI">TNI</option>
                    <option value="POLRI">POLRI</option>
                    <option value="INTERNAL">INTERNAL</option>
                    <option value="Kru Kapal">Kru Kapal</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Nomor Pekerja</label>
                  <input type="text" value={authForm.workerNumber} onChange={e => handleFieldChange('workerNumber', e.target.value)} placeholder="Contoh: PKJ-001245" className={getInputClass('workerNumber')} />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Alamat Email</label>
            <input type="email" value={authForm.email} onChange={e => handleFieldChange('email', e.target.value)} placeholder="nama@domain.com" className={getInputClass('email')} />
          </div>

          <div className="relative">
            <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Password</label>
            <input type={showPassword ? 'text' : 'password'} value={authForm.password} onChange={e => handleFieldChange('password', e.target.value)} placeholder="********" className={getInputClass('password') + " pr-12"} />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-[34px] text-cyan-600 hover:text-cyan-400 transition-colors">
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          {authMode === 'register' && (
            <>
              <div>
                <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">Konfirmasi Password</label>
                <input type="password" value={authForm.confirmPassword} onChange={e => handleFieldChange('confirmPassword', e.target.value)} placeholder="********" className={getInputClass('confirmPassword')} />
              </div>

              <div>
                <label className="text-[10px] font-mono text-cyan-500 mb-1.5 block uppercase tracking-widest pl-1">No Telpon</label>
                <input type="tel" value={authForm.phone} onChange={handlePhoneChange} placeholder="0812-xxxx-xxxx-xxxxx" className={getInputClass('phone')} />
              </div>
            </>
          )}

          <button onClick={authMode === 'login' ? handleLogin : onSubmitRegister} disabled={authBusy} className="w-full py-4 bg-cyan-600 hover:bg-cyan-500 text-white font-black uppercase tracking-widest text-xs rounded-xl transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] disabled:opacity-50 flex items-center justify-center gap-2">
            {authBusy ? <span className="animate-pulse">Memproses...</span> : authMode === 'login' ? 'Login' : 'Kirim Registrasi'}
          </button>
        </div>

        {authMode === 'login' && <DemoAccountPicker />}

        <div className="mt-8 text-center">
          <p className="text-[10px] text-cyan-700">SmartPatrol By HSSE - Security III</p>
          <p className="text-[10px] text-cyan-700">PT Pertamina Patra Niaga</p>
        </div>
      </div>
    </div>
  );
}
