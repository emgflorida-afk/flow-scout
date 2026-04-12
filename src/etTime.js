// etTime.js - Stratum Flow Scout
// Shared Eastern Time utility -- DST-aware
// Uses Intl API instead of hardcoded UTC-4 offset
// CORRECT for both EDT (Mar-Nov, UTC-4) and EST (Nov-Mar, UTC-5)

'use strict';

function getETTime(date) {
  var d = date || new Date();
  var etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  var timePart = etStr.split(', ')[1] || etStr;
  var parts = timePart.split(':');
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var s = parseInt(parts[2], 10) || 0;
  return { hour: h, min: m, sec: s, total: h * 60 + m, now: d };
}

function isMarketOpen() {
  var et = getETTime();
  var d = new Date();
  var dayStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dayStr === 'Sat' || dayStr === 'Sun') return false;
  return et.total >= (9 * 60 + 30) && et.total < (16 * 60);
}

function isWeekday() {
  var d = new Date();
  var dayStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return dayStr !== 'Sat' && dayStr !== 'Sun';
}

function getTodayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

module.exports = { getETTime: getETTime, isMarketOpen: isMarketOpen, isWeekday: isWeekday, getTodayET: getTodayET };
