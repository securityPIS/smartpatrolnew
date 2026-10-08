import React from 'react';
import { useAuth, useRole, useShips, useUI, useUsers } from '../context/AppContextRuntime';
import { Shield, Ship, UserCog, Moon, Sun, LogOut, Settings, Wifi, WifiOff, Users, Anchor, BarChart3, CalendarRange } from 'lucide-react';

const Header = React.memo(function Header() {
  const { currentUser, currentUserRecord, currentUserRole, isAdmin, isPic } = useRole();
  const { theme, setTheme, isOffline, setCurrentPage, showSettingsDropdown, setShowSettingsDropdown, setShowNotificationsDropdown } = useUI();
  const { clearUserManagementFeedback, setSelectedUser, setShowUserForm } = useUsers();
  const { setActiveShipId, setShowShipForm, closeShipDocForm, setIsEditingShipInfo } = useShips();
  const { handleLogout } = useAuth();
  const canAccessDashboard = isAdmin || isPic;

  return (
    <div className="sticky top-0 z-40 bg-[#0b1229]/90 backdrop-blur-md border-b border-cyan-800 px-4 py-3 flex justify-between items-center shadow-[0_4px_15px_rgba(6,182,212,0.1)]">
      <div className="flex items-center gap-3">
        <div className="relative flex items-center justify-center w-10 h-10 lg:hidden">
          <Shield className="w-10 h-10 text-cyan-400 stroke-[1.5] opacity-20 absolute" />
          <Shield className="w-10 h-10 text-cyan-400 stroke-1 absolute" />
          <Ship className="w-5 h-5 text-cyan-400 relative z-10 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-cyan-50">SmartPatrol</h1>
            <span className={`px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-widest uppercase ${isAdmin ? 'bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30' : isPic ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'}`}>{currentUserRole}</span>
          </div>
          <p className="text-[10px] text-cyan-500 mt-0.5">
            {currentUser}
            {!isAdmin && currentUserRecord?.shipAssigned ? ` · ${currentUserRecord.shipAssigned}` : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-bold">
          {isOffline ? (
            <span className="flex items-center gap-1 text-[#ED1C24]"><WifiOff className="w-5 h-5" /></span>
          ) : (
            <span className="flex items-center gap-1 text-[#39B54A]"><Wifi className="w-5 h-5" /></span>
          )}
        </div>
        <div className="relative z-50">
          <button onClick={() => { setShowSettingsDropdown(!showSettingsDropdown); setShowNotificationsDropdown(false); }} className="p-1.5 rounded-full border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 transition-colors flex items-center justify-center" aria-label="Pengaturan">
            <Settings className="w-5 h-5" />
          </button>
          {showSettingsDropdown && (
            <div className="absolute right-0 top-10 mt-2 w-48 bg-[#0b1229] border border-cyan-800 rounded shadow-xl py-1 z-50">
              <button onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); setShowSettingsDropdown(false); }} className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50">
                {theme === 'dark' ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-cyan-400" />} {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              </button>
              <button
                onClick={() => {
                  clearUserManagementFeedback();
                  setShowUserForm(false);
                  setSelectedUser(currentUserRecord ? { ...currentUserRecord, password: '' } : null);
                  setShowSettingsDropdown(false);
                }}
                className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50"
              >
                <UserCog className="w-4 h-4" /> Edit Data Saya
              </button>
              {canAccessDashboard && (
                <button
                  onClick={() => {
                    setActiveShipId(null);
                    setCurrentPage('daily-report');
                    setShowSettingsDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50"
                >
                  <BarChart3 className="w-4 h-4" /> Daily Report
                </button>
              )}
              {canAccessDashboard && (
                <button
                  onClick={() => {
                    setActiveShipId(null);
                    setCurrentPage('schedule');
                    setShowSettingsDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50"
                >
                  <CalendarRange className="w-4 h-4" /> Jadwal Penugasan
                </button>
              )}
              {isAdmin && (
                <>
                  <button
                    onClick={() => {
                      clearUserManagementFeedback();
                      setShowUserForm(false);
                      setSelectedUser(null);
                      setActiveShipId(null);
                      setCurrentPage('users');
                      setShowSettingsDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50"
                  >
                    <Users className="w-4 h-4" /> Menu User
                  </button>
                  <button
                    onClick={() => {
                      setShowShipForm(false);
                      closeShipDocForm();
                      setIsEditingShipInfo(false);
                      setActiveShipId(null);
                      setCurrentPage('ships');
                      setShowSettingsDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-xs font-bold text-cyan-300 flex items-center gap-2 hover:bg-cyan-900/50"
                  >
                    <Anchor className="w-4 h-4" /> Menu Armada
                  </button>
                </>
              )}
              <div className="border-t border-cyan-900/50 my-1"></div>
              <button onClick={() => { handleLogout('Anda berhasil logout dari SmartPatrol.'); setShowSettingsDropdown(false); }} className="w-full text-left px-4 py-2 text-xs font-bold text-rose-400 flex items-center gap-2 hover:bg-cyan-900/50">
                <LogOut className="w-4 h-4" /> Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default Header;
