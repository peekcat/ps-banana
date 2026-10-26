// ============================================================
//  core/telemetry.js — 空实现 (去云化后不再采集任何数据)
//
//  原版是「用户改进计划」: 用户勾选后把匿名事件上报到作者服务器
//  (作者后台的遥测接口)。作者停服后这条链路失效, 而且 ps-banana 也不再需要
//  遥测, 所以整个模块换成空实现, 只保留同名 API — 历史调用点不用逐个删。
//
//  这个文件不做任何网络请求, 不写任何本地数据, 也不生成设备 ID。
// ============================================================
(function() {
  'use strict';

  function noop() {}
  function noopAsync() { return Promise.resolve(); }

  window._telemetry = {
    isOptedIn: function() { return false; },
    optIn: noop,
    optOut: noop,
    resetDeviceId: noop,
    getDeviceId: function() { return ''; },
    bootIfOptedIn: noop,
    trackTask: noop,
    trackTileExpand: noop,
    trackError: noop,
    event: noop,
    showOptInDialogIfNeeded: noopAsync
  };
})();
