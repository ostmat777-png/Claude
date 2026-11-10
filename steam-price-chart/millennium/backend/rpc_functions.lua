local logger     = require("logger")
local millennium = require("millennium")
local http       = require("http")
local cjson      = require("cjson")

-- Страница магазина Steam запрещает (CSP) запросы на чужие сайты, поэтому
-- история цен (IsThereAnyDeal) и курсы валют скачиваются здесь, в бэкенде.
-- Только GET и только на эти сайты: плагин не должен быть открытым прокси.
local ALLOWED_HOSTS = {
    ["api.isthereanydeal.com"] = true,
    ["www.cbr-xml-daily.ru"] = true,
    ["cdn.jsdelivr.net"] = true,
    ["latest.currency-api.pages.dev"] = true,
    ["store.steampowered.com"] = true,
}

local SETTING_KEYS = {
    itadKey = true,
    homeRegion = true,
    historyRegion = true,
}

local function result(tbl)
    local ok, encoded = pcall(cjson.encode, tbl)
    if ok then
        return encoded
    end
    return '{"status":0,"error":"encode failed"}'
end

---@ffi
--- GET-запрос на один из разрешённых сайтов. Возвращает JSON-строку {status, body} или {status = 0, error}.
---@param url string
---@return string
function spcFetch(url)
    if type(url) ~= "string" then
        return result({ status = 0, error = "bad url" })
    end
    local host = url:match("^https://([^/:?#]+)")
    if not host or not ALLOWED_HOSTS[host:lower()] then
        return result({ status = 0, error = "host not allowed" })
    end

    local ok, res, err = pcall(http.get, url, {
        timeout = 20,
        headers = { ["Accept"] = "application/json" },
        user_agent = "Mozilla/5.0 (Steam Price Chart)",
    })
    if not ok then
        logger:error("spcFetch failed: " .. tostring(res))
        return result({ status = 0, error = tostring(res) })
    end
    if not res then
        return result({ status = 0, error = tostring(err or "request failed") })
    end
    return result({ status = res.status, body = res.body or "" })
end

---@ffi
--- Прочитать настройку плагина. Пустая строка, если не задана.
---@param key string
---@return string
function spcGetSetting(key)
    if not SETTING_KEYS[key] then
        return ""
    end
    local ok, value = pcall(millennium.config.get, key)
    if ok and type(value) == "string" then
        return value
    end
    return ""
end

---@ffi
--- Сохранить настройку плагина (хранится в конфиге Millennium).
---@param key string
---@param value string
---@return boolean
function spcSetSetting(key, value)
    if not SETTING_KEYS[key] or type(value) ~= "string" then
        return false
    end
    local ok, saved = pcall(millennium.config.set, key, value)
    return ok and saved == true
end

logger:info("Steam Price Chart RPC functions registered")
