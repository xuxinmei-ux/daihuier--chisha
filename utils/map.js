// utils/map.js —— 高德地图（微信小程序 SDK）封装
// + 归一化 / 半径校验 / 去重 / 排除过滤 / 兜底搜索
// 说明：不装 npm 包，官方 SDK（amap-wx.js）放在同目录，直接 require 使用；
//       门店数据 100% 来自高德开放平台，工程内没有任何本地假数据。
// 使用前：
//   ① https://lbs.amap.com → 控制台 → 应用管理 → 我的应用 → 添加 Key，
//      「服务平台」必须选 **微信小程序**，并绑定你的小程序 AppID（选 Web 服务会报 10001）；
//   ② 把 Key 填到下面的 KEY（不填也能编译，点「转！别想了」会弹中文指引）；
//   ③ 发布前到小程序后台「开发管理 → 开发设置 → 服务器域名 → request 合法域名」
//      添加 https://restapi.amap.com
//      （开发阶段可先在开发者工具「详情 → 本地设置」勾「不校验合法域名」）。

// 高德 Key（微信小程序类型）。使用者需自行申请后替换；留空不会白屏，会弹中文指引
const KEY = 'YOUR_AMAP_KEY';

// 官方 SDK 里 key 直接进请求参数，空值不会被拦在这里；
// 但仍用哨兵值实例化，真正发请求前由 noKeyError() 拦下并给中文指引
const PLACEHOLDER_KEY = 'NOT_SET_YET';

// SDK 文件缺失时 require 会直接抛错，导致整包白屏 —— 这里兜一层，
// 让页面拿到「缺少 SDK」的中文错误，而不是白屏
let AMapWX = null;
try {
  AMapWX = require('./amap-wx.js').AMapWX;
} catch (e) {
  console.warn('[map] 没加载到 utils/amap-wx.js：', e && e.message);
}

const amap = (typeof AMapWX === 'function') ? new AMapWX({ key: KEY || PLACEHOLDER_KEY }) : null;

const LOCATION_TIMEOUT = 8000;
const REO_TIMEOUT = 5000;          // 逆地理解析兜底超时（SDK 在无道路数据时会卡住）
const PAGE_SIZE = 25;              // 高德周边搜索单页上限 25（SDK 不转发 offset 时接口默认 20）
const DEFAULT_RADIUS = 500;

/**
 * 排除法分类表
 * key     显示名（同时作为兜底搜索关键词）
 * emoji   贴纸风格图标
 * tokens  匹配高德 type（形如 "餐饮服务;中餐厅;综合酒楼"）用，也拼上店名一起匹配，命中率更高
 */
const CATEGORIES = [
  { key: '小吃', emoji: '🍢', tokens: ['小吃', '零食', '卤味', '炸串', '串串', '烤冷面', '凉皮', '肉夹馍', '臭豆腐', '关东煮'] },
  { key: '快餐', emoji: '🍔', tokens: ['快餐', '便当', '汉堡', '炸鸡', '披萨', '简餐', '麻辣烫', '沙县', '盖浇饭', '肯德基', '麦当劳'] },
  { key: '面食', emoji: '🍜', tokens: ['面食', '面馆', '拉面', '牛肉面', '刀削面', '面条', '馄饨', '饺子', '包子', '米粉', '螺蛳粉', '米线'] },
  { key: '米饭', emoji: '🍚', tokens: ['米饭', '炒饭', '盖饭', '黄焖鸡', '煲仔饭', '家常菜', '小炒', '食堂'] },
  { key: '火锅', emoji: '🍲', tokens: ['火锅', '涮', '麻辣锅', '串串香', '羊蝎子'] },
  { key: '烧烤', emoji: '🍡', tokens: ['烧烤', '烤肉', '烤串', '铁板烧', '小龙虾', '大排档', 'bbq'] },
  { key: '日料', emoji: '🍣', tokens: ['日料', '日本料理', '日式', '寿司', '居酒屋', '刺身', '烧鸟', '天妇罗', '日韩料理', '韩国料理', '石锅拌饭'] },
  { key: '西餐', emoji: '🍝', tokens: ['西餐', '西式', '牛排', '牛扒', '意面', '意大利', '法餐', '外国餐厅'] },
  { key: '甜品', emoji: '🍰', tokens: ['甜品', '蛋糕', '面包', '烘焙', '冰淇淋', '冰激凌', '糖水', '糕点', '面包甜点', '甜点'] },
  { key: '咖啡奶茶', emoji: '☕', tokens: ['咖啡', '奶茶', '茶饮', '饮品', '果茶', '柠檬茶', '咖啡厅', '冷饮', '茶艺馆'] }
];

// 匹配优先级：越靠前越"专属"，避免"西餐厅"被"米饭"的 token（中餐厅）抢走
const MATCH_ORDER = ['日料', '西餐', '火锅', '烧烤', '咖啡奶茶', '甜品', '面食', '快餐', '米饭', '小吃'];

// 平台给的"泛"类目（高德"餐饮服务;中餐厅;综合酒楼"）：认不出具体菜系时兜底算作米饭类，
// 保证"不想吃米饭"这类排除对普通中餐馆也生效
const GENERIC_TOKENS = [
  { key: '米饭', tokens: ['中餐厅', '中餐', '餐厅', '家常菜', '小炒', '食堂', '餐饮'] }
];

const CATEGORY_MAP = {};
CATEGORIES.forEach(function (c) { CATEGORY_MAP[c.key] = c; });

/** 球面距离（米） */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** 去掉空白与常见标点，用于店名去重 */
function nameKey(name) {
  return String(name || '').replace(/[\s·•\-—_（）()【】[\],，。.、]/g, '').toLowerCase();
}

/**
 * 把平台分类串统一成"空格分隔的可匹配文本"
 * 高德："餐饮服务;中餐厅;综合酒楼"
 * 不同分隔符（; : ： | / 、 , ，）全拍平成空格，剩下的就是纯子串匹配
 */
function categoryText(text) {
  return String(text || '').replace(/[;:：|/、,，]/g, ' ');
}

/** 在一段文本里按"专属优先"的顺序找类别 key */
function matchCategoryKey(text) {
  if (!text) return '';
  const low = categoryText(text).toLowerCase();
  for (let i = 0; i < MATCH_ORDER.length; i++) {
    const cat = CATEGORY_MAP[MATCH_ORDER[i]];
    if (!cat) continue;
    for (let j = 0; j < cat.tokens.length; j++) {
      if (low.indexOf(String(cat.tokens[j]).toLowerCase()) > -1) return cat.key;
    }
  }
  return '';
}

/**
 * 推断类别，三步走：
 * 1) 只看平台返回的 type（最权威，"餐饮服务;外国餐厅;日本料理" -> 日料）
 * 2) 认不出再看 type + 店名（"餐饮服务;中餐厅" + 老张牛肉面 -> 面食）
 * 3) 还是认不出，用泛类目兜底（"餐饮服务;中餐厅" -> 米饭），保证排除功能对它也生效
 */
function guessCategoryKey(poi) {
  const cat = String((poi && (poi.type || poi.category)) || '');
  const title = String((poi && (poi.name || poi.title)) || '');

  const byCategory = matchCategoryKey(cat);
  if (byCategory) return byCategory;

  const byName = matchCategoryKey(cat + ' ' + title);
  if (byName) return byName;

  const low = categoryText(cat).toLowerCase();
  for (let i = 0; i < GENERIC_TOKENS.length; i++) {
    const g = GENERIC_TOKENS[i];
    for (let j = 0; j < g.tokens.length; j++) {
      if (low.indexOf(String(g.tokens[j]).toLowerCase()) > -1) return g.key;
    }
  }
  return '';
}

function guessEmoji(poi) {
  const cat = guessCategoryKey(poi);
  return (CATEGORY_MAP[cat] && CATEGORY_MAP[cat].emoji) || '🍽';
}

/**
 * 解析坐标，三种格式都吃：
 * 高德：location = "113.264385,23.129112"（经度在前）
 * 对象：{ lng, lat } 或 { longitude, latitude }
 */
function parseLocation(loc) {
  if (typeof loc === 'string') {
    const p = loc.split(',');
    return { lng: Number(p[0]), lat: Number(p[1]) };
  }
  const o = loc || {};
  const lat = (o.lat !== undefined && o.lat !== null) ? o.lat : o.latitude;
  const lng = (o.lng !== undefined && o.lng !== null) ? o.lng : o.longitude;
  return { lat: Number(lat), lng: Number(lng) };
}

/** 高德要的 location 串：经度在前，保留 6 位小数（与官方 SDK 示例一致） */
function formatLocation(latitude, longitude) {
  return Number(longitude).toFixed(6) + ',' + Number(latitude).toFixed(6);
}

/** 距离（米）：高德 distance 是"米"的字符串；缺失时自己用球面距离算 */
function distanceOf(poi, origin) {
  const p = poi || {};
  let distance = Number(p.distance);
  if (!distance || isNaN(distance)) {
    const loc = parseLocation(p.location || p);
    distance = (origin && !isNaN(origin.latitude) && !isNaN(loc.lat) && !isNaN(loc.lng))
      ? haversine(origin.latitude, origin.longitude, loc.lat, loc.lng)
      : null;
  }
  return distance;
}

/**
 * 把高德 POI 归一化成页面用的统一结构（9 个字段，页面/wheel 只认这套）
 * 高德示例：
 * {
 *   id: "B0FFH4PUKS", name: "牛一安格斯牛扒(府前大楼店)",
 *   type: "餐饮服务;外国餐厅;牛扒店(扒房)",
 *   address: "北京街道街府前路15号", location: "113.268123,23.129456",
 *   distance: "182", pname: "广东省", cityname: "广州市", adname: "越秀区"
 * }
 * 注意：address 有时是数组（高德个别业态返回 ["a","b"]），先 join 再兜底拼省市区
 */
function normalizePoi(poi, origin) {
  const p = poi || {};
  const loc = parseLocation(p.location);
  const name = String(p.name || p.title || '无名小店');

  let address = p.address;
  if (Array.isArray(address)) address = address.join('');
  address = String(address || '').replace(/\s+/g, ' ').trim();
  if (!address) {
    address = String((p.pname || '') + (p.cityname || '') + (p.adname || '')).trim();
  }
  if (!address) address = '地址暂缺';

  const catKey = guessCategoryKey(p);
  const distance = distanceOf(p, origin);

  return {
    id: String(p.id || ('nm_' + nameKey(name))),
    name: name,
    catKey: catKey,
    category: String(p.type || p.category || catKey || '餐饮'),
    address: address,
    latitude: loc.lat,
    longitude: loc.lng,
    distance: (distance === null || isNaN(distance)) ? null : Number(distance),
    emoji: guessEmoji(p)
  };
}

/** 按 id（没有 id 就按"店名+坐标"）去重，保留先出现的 */
function dedupe(list) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (item) {
    if (!item) return;
    const key = item.id ? ('id:' + item.id) : ('nm:' + nameKey(item.name) + '@' + item.latitude + ',' + item.longitude);
    if (seen[key]) return;
    seen[key] = true;
    out.push(item);
  });
  return out;
}

/** 用户在转盘上点了"不想吃"的类别，直接整条剔除 */
function isExcluded(item, excluded) {
  if (!item || !excluded || !excluded.length) return false;
  for (let i = 0; i < excluded.length; i++) {
    const ex = excluded[i];
    if (!ex) continue;
    if (item.catKey === ex || item.category === ex) return true;
  }
  return false;
}

function noKeyError() {
  const e = new Error('还没填高德 Key');
  e.noKey = true;
  e.status = '';
  e.raw = KEY;
  return e;
}

function noSdkError() {
  const e = new Error('缺少高德小程序 SDK');
  e.noSdk = true;
  e.status = '';
  e.raw = 'utils/amap-wx.js 不在工程里';
  return e;
}

function requestFailText(msg) {
  const m = String(msg || '');
  if (/url not in domain list/i.test(m)) return '域名没放行';
  return '高德接口没响应';
}

/**
 * 错误码 → 人话（永远只给一句能落地的）
 * 高德 infocode 表：10001 Key 无效/平台不符；10003 日配额用完；10004 访问过频；
 * 10005 IP 不在白名单；10007 平台不匹配或开了数字签名；10009 Key 被回收/绑定不符；
 * 10010 参数不合法；10012 单位时间配额超限
 */
const ERR_TEXT = {
  '10001': 'Key 无效或类型不对：控制台把服务平台改成「微信小程序」',
  '10003': '今天的免费额度用完了：明天再试，或去控制台充值',
  '10004': '请求太频繁：等 10 秒再点一次',
  '10005': 'IP 不在白名单里：控制台清空白名单即可',
  '10007': 'Key 与平台不符：确认是「微信小程序」Key，并关掉数字签名',
  '10009': 'Key 绑定关系不对：控制台确认 Key 与 AppID 的绑定',
  '10010': '请求参数不合法：检查定位是否没给到经纬度',
  '10012': '访问频率超限：慢一点点',
  '0': '手机网络不通：高德接口没连上'
};

function explainError(err) {
  if (!err) return '出了点小状况，再点一次';
  if (err.noKey) return '还没填高德 Key：先去 lbs.amap.com 建一个「微信小程序」类型的 Key，填进 utils/map.js 的 KEY';
  if (err.noSdk) return '少了 utils/amap-wx.js：把高德官方 SDK 放进 utils 目录再编译';
  if (err.isDomainBlocked) return '域名没放行：小程序后台加 https://restapi.amap.com，或开发者工具勾「不校验合法域名」';
  const code = String(err.status || '');
  if (code && ERR_TEXT[code]) return ERR_TEXT[code];
  if (err.status === -1 || /timeout|超时/i.test(err.raw || '')) return '翻菜单翻太久：网络有点慢，再转一次';
  if (/fail|error|失败/i.test(err.raw || '')) return '高德接口没响应：检查手机网络再试';
  return err.message || '出了点小状况，再点一次';
}

/**
 * 单次周边搜索，resolve 出高德原始 POI 数组（已按半径客户端过滤 + 截断到 pageSize）
 *
 * ⚠️ 实测坑：官方 amap-wx.js 的 getPoiAround 只把 querytypes / querykeywords 拼进请求，
 *    **radius / offset / page / sortrule / extensions 会被静默丢掉**，接口永远按默认
 *    （3km、20 条、综合排序）返回。所以：
 *    ① 这些参数照样传 —— 换到支持它们的 SDK 版本时自动生效；
 *    ② 半径必须在客户端自己筛：distance 字段就在 POI 里，超过 radius 的直接丢，
 *       这样"500 米内"才是真的 500 米，不是接口的 3 公里。
 */
function searchKeyword(p) {
  const pageSize = Math.min(Number(p.pageSize) || PAGE_SIZE, PAGE_SIZE);
  const radius = Number(p.radius) || DEFAULT_RADIUS;
  const origin = { latitude: Number(p.latitude), longitude: Number(p.longitude) };

  return new Promise(function (resolve, reject) {
    if (!KEY) {
      reject(noKeyError());
      return;
    }
    if (!amap) {
      reject(noSdkError());
      return;
    }

    const opts = {
      // 高德：经度在前、纬度在后，6 位小数；传反了会搜到另一个城市
      location: formatLocation(origin.latitude, origin.longitude),
      radius: String(radius),
      querykeywords: p.keyword || '美食',
      offset: pageSize,
      page: 1,
      sortrule: 'distance',
      extensions: 'base',
      // 不传 types：高德一级类目"餐饮服务"下漏店多，关键词搜反而更全
      success: function (res) {
        // 高德 SDK 回的是 { markers, poisData }，原始数组在 poisData；
        // 兼容纯数组 / res.pois，避免 SDK 升级换结构就崩
        const raw = Array.isArray(res)
          ? res
          : ((res && (res.poisData || res.pois)) || []);

        const kept = [];
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] || {};
          const d = distanceOf(item, origin);
          // 算不出距离的不丢（极少见），能算的一律按用户半径卡死
          if (d === null || d <= radius) kept.push(item);
        }
        resolve(kept.slice(0, pageSize));
      },
      fail: function (err) {
        const msg = (err && (err.errMsg || err.message)) || '高德地图请求失败';
        const e = new Error(requestFailText(msg));
        e.status = String((err && err.errCode) || '');
        e.raw = msg;
        e.isDomainBlocked = /url not in domain list/i.test(msg);
        reject(e);
      }
    };

    amap.getPoiAround(opts);
  });
}

/** 按距离升序（接口按 sortrule=distance 排过，客户端再排一次兜底） */
function sortByDistance(list) {
  return list.sort(function (a, b) {
    const av = (a.distance === null || a.distance === undefined) ? 9e9 : a.distance;
    const bv = (b.distance === null || b.distance === undefined) ? 9e9 : b.distance;
    return av - bv;
  });
}

/**
 * 附近餐厅主流程（与页面逻辑解耦，只依赖本文件导出的能力）
 * 1) keyword='美食' 搜一遍（pageSize 上限 25，高德接口实际按 20 条回）
 * 2) 归一化 + 去重 + 过滤掉用户排除的类别
 * 3) 过滤后不足 4 家 -> 用未排除的类别关键词分别再搜一次，合并去重
 * @returns Promise<Array> 内部结构列表，按距离升序
 */
function searchNearby(o) {
  const origin = { latitude: o.latitude, longitude: o.longitude };
  const excluded = o.excluded || [];

  return searchKeyword({
    latitude: o.latitude,
    longitude: o.longitude,
    radius: o.radius,
    keyword: '美食',
    pageSize: PAGE_SIZE
  }).then(function (raw) {
    let list = dedupe((raw || []).map(function (p) { return normalizePoi(p, origin); }))
      .filter(function (p) { return !isExcluded(p, excluded); });

    if (list.length >= 4) return sortByDistance(list);

    // 兜底：按未排除的类别关键词分别补搜，合并去重
    const allowed = CATEGORIES.filter(function (c) { return excluded.indexOf(c.key) === -1; });
    const tasks = allowed.map(function (c) {
      return searchKeyword({
        latitude: o.latitude,
        longitude: o.longitude,
        radius: o.radius,
        keyword: c.key,
        pageSize: 10
      }).catch(function () { return []; }); // 单个关键词失败不阻塞主流程
    });

    return Promise.all(tasks).then(function (groups) {
      const extra = [];
      groups.forEach(function (g) {
        (g || []).forEach(function (p) { extra.push(normalizePoi(p, origin)); });
      });
      list = dedupe(list.concat(extra)).filter(function (p) { return !isExcluded(p, excluded); });
      return sortByDistance(list);
    });
  });
}

/**
 * 转盘候选池：> max 随机取 max 家，2~max 全上，< 2 返回空数组（页面走空状态）
 * @param avoidId 上一次选中的店，能避开就避开（池子太小则不强求）
 */
function sampleForWheel(list, max, avoidId) {
  const pool = (list || []).slice();
  if (pool.length < 2) return [];
  // Fisher-Yates 洗牌
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const limit = Math.min(max || 8, pool.length);
  const out = pool.slice(0, limit);
  if (avoidId && limit > 1) {
    let hit = -1;
    for (let k = 0; k < out.length; k++) {
      if (out[k].id === avoidId) { hit = k; break; }
    }
    if (hit > -1) {
      for (let m = limit; m < pool.length; m++) {
        if (pool[m].id !== avoidId) { out[hit] = pool[m]; break; }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------
 * 定位 / 逆地址解析
 * ------------------------------------------------------------------ */

/**
 * 定位 Promise 封装，denied=true 表示用户拒绝授权
 * 微信 getLocation 与高德同为 GCJ-02，坐标系一致，无需转换
 * 返回 { latitude, longitude, accuracy }
 */
function locate() {
  return new Promise(function (resolve, reject) {
    wx.getLocation({
      type: 'gcj02',                 // 高德和微信都用 GCJ-02；换成 wgs84 会整体偏几百米
      isHighAccuracy: true,          // 强开 GPS：false 走基站/WiFi，城里误差能到几百米
      highAccuracyExpireTime: 4000,  // 最多等 4 秒拿一个高精度坐标
      timeout: LOCATION_TIMEOUT,
      success: function (res) {
        const pos = {
          latitude: res.latitude,
          longitude: res.longitude,
          accuracy: Math.round(res.accuracy || 0)   // 精度（米），用来判断坐标靠不靠谱
        };
        console.log('[locate]', pos);
        resolve(pos);
      },
      fail: function (err) {
        const msg = (err && err.errMsg) || '';
        const denied = /auth deny|auth denied|authorize|permission/i.test(msg);
        const e = new Error(denied ? '定位权限被拒绝' : '定位失败');
        e.denied = denied;
        e.raw = msg;
        reject(e);
      }
    });
  });
}

/**
 * 逆地址解析：把坐标翻译成"城市+区"
 * 只用来给用户自检（卡片上看到"广州市越秀区"，人不在广州就立刻知道坐标不对），失败静默
 *
 * ⚠️ 两个实测坑：
 * ① 高德 SDK 的 getRegeo 内部写死了 g.roads[0].name，**roads 为空时会在回调里抛异常**，
 *    我们的 success 永远不会被调用 -> Promise 永久 pending。外面套一个 REO_TIMEOUT 兜底。
 * ② Web 接口返回的是 formatted_address（下划线），SDK 又另拼了个 name 字段，
 *    所以按 formatted_address -> roads[0].name -> 附近 POI 名 三级兜底。
 */
function regeo(latitude, longitude) {
  return new Promise(function (resolve, reject) {
    if (!KEY) {
      reject(noKeyError());
      return;
    }
    if (!amap) {
      reject(noSdkError());
      return;
    }

    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      const e = new Error('逆地址解析超时');
      e.status = '';
      e.raw = 'timeout';
      reject(e);
    }, REO_TIMEOUT);

    amap.getRegeo({
      location: formatLocation(latitude, longitude),
      success: function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);

        const first = Array.isArray(res) ? res[0] : res;
        const rg = (first && (first.regeocodeData || first.regeocode)) || {};
        const ac = rg.addressComponent || {};
        const city = ac.city || ac.province || ac.provice || '';   // 直辖市 city 为空，退回 province
        const district = ac.district || '';

        let addr = String(rg.formatted_address || rg.formattedAddress || '').trim();
        if (!addr) {
          const roads = rg.roads || [];
          addr = (roads[0] && roads[0].name) ? roads[0].name : '';
        }
        if (!addr) addr = (rg.pois && rg.pois[0] && rg.pois[0].name) || '';

        resolve({
          city: city,
          district: district,
          label: city + district,          // 例如"广州市越秀区"
          address: addr                    // 例如"府前路15号"
        });
      },
      fail: function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const msg = (err && (err.errMsg || err.message)) || '逆地址解析失败';
        const e = new Error(requestFailText(msg));
        e.status = String((err && err.errCode) || '');
        e.raw = msg;
        e.isDomainBlocked = /url not in domain list/i.test(msg);
        reject(e);
      }
    });
  });
}

module.exports = {
  KEY: KEY,
  CATEGORIES: CATEGORIES,
  MATCH_ORDER: MATCH_ORDER,
  haversine: haversine,
  nameKey: nameKey,
  guessCategoryKey: guessCategoryKey,
  guessEmoji: guessEmoji,
  normalizePoi: normalizePoi,
  dedupe: dedupe,
  isExcluded: isExcluded,
  searchKeyword: searchKeyword,
  searchNearby: searchNearby,
  explainError: explainError,
  sampleForWheel: sampleForWheel,
  locate: locate,
  regeo: regeo
};


