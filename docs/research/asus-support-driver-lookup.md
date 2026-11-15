# ASUS driver/BIOS lookup via the ASUS support site feed

Date: 2026-11-15. Status: research only, nothing built. Question: can the device **Drivers** tab
(`feature/device-drivers`) show newer ASUS drivers/BIOS for an ASUS PC by reading the data feed
the ASUS support website itself uses?

**Short answer:** Technically yes, and the feed is better than expected. It is plain JSON with no
login, and it includes hardware IDs, SHA-256 hashes and silent-install switches. The blocker is
the ASUS Terms of Use: the website license is **personal and non-commercial**, and **robots and
data-gathering tools** are prohibited. Recommendation: build at most an opt-in, show-only list
(BIOS first) that links to ASUS's own download page, with a kill switch. **Do not install** from
it unless ASUS gives written permission.

All requests below were made live on 2026-11-15 with `curl`, about 25 requests in total. No driver
or BIOS package was downloaded; only one `HEAD` request was sent to the download host.

---

## 1. Endpoints

Base: `https://www.asus.com/support/api/product.asmx/` (GET, JSON, no auth, no cookies, no CSRF token).

| Endpoint | Purpose | Verified call |
|---|---|---|
| `GetPDOS` | OS list for a model | `?website=global&model=G614JV&pdid=&pdhashedid=&siteID=www&sitelang=` returns `[{Id:"52",Name:"Windows 11 64-bit"},{Id:"8",Name:"Others"}]` |
| `GetPDDrivers` | Drivers & tools for model + OS | `?website=global&model=G614JV&cpu=&osid=52&pdhashedid=&pdid=&siteID=www&sitelang=` returns 47 files in 7 categories, **2.8 MB** |
| `GetPDBIOS` | BIOS & firmware (OS independent) | `?website=global&model=G614JV&cpu=&pdhashedid=&pdid=&siteID=www&sitelang=` returns BIOS Update (Windows), BIOS (EZ Flash zip) and Firmware (SSD), 63 KB |
| `GetPDSupportTab` | Links to the human support pages | gives `https://www.asus.com/supportonly/G614JV/HelpDesk_Download/` and `.../HelpDesk_BIOS/`, which are good link targets |

Test model: **G614JV**, the ROG Strix G16 (2023). Windows 11 64-bit is `osid=52`.

### Model resolution: `pdhashedid` is not needed
- `model=<board/short model name>` alone is enough. `pdhashedid` and `pdid` can be left empty.
- `model=G614JV` returns `SUCCESS`. `model=G614JV_G614JV`, the long marketing string `ROG Strix G16 G614JV_G614JV`, and a nonsense name all return `{"Result":null,"Status":"FAIL"}` (still HTTP 200).
- Desktop motherboards work the same way: `model=ROG STRIX B550-F GAMING` returns `SUCCESS` with BIOS entries.
- Do not use the OS id as a constant. Call `GetPDOS` per model. `osid=8` ("Others") returned 0 drivers for this model.
- The `cpu` parameter exists for models sold with several CPU variants. It was empty in every test; its effect on such models is untested.
- Product search (`odinapi.asus.com/.../SearchSuggestion`) returns marketing pages, not support model ids, and `robots.txt` disallows `*SearchKey` paths. Do not use it.

### Response shape
```
Result.Obj[]            categories: Name ("Networking", "Chipset", "Audio", "Graphics", "Pointing Device",
                        "Bluetooth", "Software and Utility" / "BIOS Update(Windows)", "BIOS", "Firmware")
  .Files[]              ALL historical versions, not just the latest
    Title, Version      "Realtek LAN Driver", "V10.066.0621.2023"  (BIOS: "334")
    ReleaseDate         "2023/08/10"
    FileSize            "4.54 MB" (string)
    Description         HTML (min OS version, device list, notes)
    DownloadUrl.Global  https://dlcdnets.asus.com/pub/ASUS/...exe?model=G614JV   (DownloadUrl.China is usually empty)
    sha256              hex SHA-256 of the package
    Sign                ~256-byte hex blob (looks like an RSA-2048 signature; purpose undocumented,
                        probably checked by MyASUS)
    HardwareInfoList[]  {hardwareid:"PCI\\VEN_10EC&DEV_8125&REV_05", date:null, version:null}
    INFDate             "06-21-2023" (date of the INF inside the package)
    ExeModule           "LAN_...exe%%/SUPPRESSMSGBOXES /VERYSILENT /NORESTART"  (silent install switch)
    Reboot, Ac_power    "1"/"0", "True"/"False" (BIOS: reboot 1, AC power True)
    Severity, severityContentWording  "2", "Recommended"
    IsRelease, Usefor, Tid, SWID, UserSession, comboPackage, installTime, assistant_key
```
Notes:
- In `GetPDBIOS`, `Result.Count` (26) and each category's `Count` (1) do not equal the number of files; `BIOS Update(Windows)` holds 12 versions. Ignore the counts.
- The `Files` order is **not** reliably newest-first: 6 of 7 driver categories were not sorted by date. Group by `Title` and pick the latest by `ReleaseDate`.
- 7 entries point to `www.microsoft.com/store/apps/...` instead of an ASUS file. These are Store apps (MyASUS, GlideX, NVIDIA Control Panel, Intel Graphics Command Center, Realtek Audio Console, Thunderbolt Control Center) with the title "latest version at the MS store". Show them as links or skip them.
- 16 of 47 driver entries have no `HardwareInfoList`. Most are "Software and Utility" (11 of 14).
- The download host is `dlcdnets.asus.com`, which is AWS S3 behind CloudFront. `HEAD` on the BIOS exe returned 200 `application/octet-stream`, 16.5 MB, `Last-Modified` matching the release date, with no auth or cookie.

## 2. Mapping a Windows device to the feed

**Not verified on a real ASUS PC.** This workstation is not an ASUS, and reading the fleet
device's stored inventory was not possible from this session. The rule below follows the
API's behaviour and the usual ASUS SMBIOS conventions. It must be checked on ASUS-ROG-STRIX-III
before anything is built:
```powershell
Get-CimInstance Win32_ComputerSystem | Select Manufacturer, Model, SystemSKUNumber
Get-CimInstance Win32_BaseBoard | Select Manufacturer, Product
Get-CimInstance Win32_BIOS | Select SMBIOSBIOSVersion
```
Usual values on ASUS laptops: Model `ROG Strix G614JV_G614JV` (or similar), BaseBoard.Product `G614JV`,
SMBIOSBIOSVersion `G614JV.334`.

Candidate model ids, in order (stop at the first that returns `Status:"SUCCESS"`):
1. `Win32_BaseBoard.Product` as is. This is right for desktop boards (`ROG STRIX B550-F GAMING`) and usually for laptops.
2. The prefix of `SMBIOSBIOSVersion` before the last `.` (`G614JV.334` gives `G614JV`). Laptops only.
3. The last space-separated token of `Win32_ComputerSystem.Model`, cut at the first `_` (`..._G614JV` gives `G614JV`).

Apply this only when Manufacturer matches `ASUSTeK*` / `ASUS*`. Cache misses (`FAIL`) too, so an
unknown model is not looked up again on every scan.

### Comparing installed vs available
- **BIOS: reliable.** The suffix of `SMBIOSBIOSVersion` after the last `.` (`334`) compares
  numerically with `Version` (`334`). Take the latest entry by `ReleaseDate`/`Version` in
  "BIOS Update(Windows)". If the installed number is lower, the BIOS is out of date.
- **Drivers: weak.** `Version` is the ASUS *package* version, which is often not the driver's
  `DriverVersion` (for example `V10.066.0621.2023` vs `10.66.621.2023`), and `HardwareInfoList`
  version/date are always null. The best signal is:
  match `HardwareInfoList[].hardwareid` against `Win32_PnPSignedDriver.HardWareID` / compatible IDs
  (the Drivers tab scan already collects these), then compare `INFDate` with the installed
  `DriverDate`. If ASUS's INF is newer, mark it "possibly newer". It cannot say "newer" with
  certainty, and it overlaps with what Windows Update already offers by hardware ID.
- Software and Utility entries without hardware IDs cannot be matched. Leave them out.

## 3. Reliability and risk

| Area | Finding |
|---|---|
| API stability | **Undocumented.** It is an internal ASP.NET `.asmx` service for the site's own front end, with no versioning and no SLA. The parameter set (`siteID`, `sitelang`, `pdhashedid`) shows it has changed before. Expect it to break without notice. |
| Rate limits | **Untested.** A few dozen requests saw no 429, CAPTCHA or challenge, even with a `curl/8.0` user agent. Responses are cached at CloudFront (`x-cache-policy: Cache1DayExceptGAQS`, `X-Cache: Hit`), so repeat queries mostly hit the CDN. No load test was done, on purpose. |
| Bot protection | None seen on the API (no Akamai/Cloudflare challenge, no cookies needed). This could change at any time. |
| robots.txt | Does not disallow `/support/api/` (it disallows search-key and filter paths only). That is not permission. |
| **Terms of Use** | Source: `asus.com/terms_of_use_notice_privacy_policy/official-site/`. **§5.1** says ASUS grants "a limited, personal, non-commercial ... license to access or enter the SERVICE". A paid SaaS reading the feed for customers is commercial use outside that license. **§1.8.4** lists as prohibited: "Using any data mining, robots, or similar data gathering and/or extraction tools". The sentence that follows ties the penalty to "Website Event" participation, but the prohibition itself is general. Do not read it as limited to events. |
| Device-side fetch | Moving the request onto the customer's PC (a Breeze script calling ASUS) does **not** change the ToS analysis. It is still automated access by a commercial product. It is not a workaround. |
| Region | `website=global/us/uk/in` returned identical BIOS data. `de` (67 KB) and `cn` (62 KB) differed in size, likely localized text, possibly different lists. Use `global`; `DownloadUrl.China` is empty for global. |
| Wrong-model risk | The feed is per model, not per SKU. Models with CPU or GPU variants rely on the `cpu` parameter (untested). Hardware ID matching reduces the risk for drivers. BIOS goes strictly by model, and flashing the wrong BIOS can brick a PC. |
| Package integrity | Each file has a `sha256`, so a downloaded file can be checked against what ASUS publishes. Authenticode signing of the `.exe` packages was **not verified**, because downloading packages was out of scope. Open item: check `Get-AuthenticodeSignature` (expected signer: ASUSTeK) on one package before any install path is considered. The `Sign` blob's format and key are undocumented. |
| Response size | `GetPDDrivers` is about 2.8 MB per model+OS, mostly the `HardwareInfoList` arrays. That is too heavy to fetch per device per scan, so the server should cache it. |

### Compared with the earlier rejection
The first Drivers research (2026-11-15, parent session notes) rejected "scraping vendor sites by
hardware ID". What is new: ASUS has a real JSON feed with hardware IDs, hashes and silent switches.
That is not HTML scraping, and it is good enough to support a feature. What has not changed: no
stable API, and the ToS still restricts commercial and automated use. The technical objection is
mostly gone; the legal and stability objections remain.

## 4. Recommendation

**Option A, show-only list with links: acceptable as an opt-in, low-volume feature, BIOS first.**
**Option B, install from the feed: do not build** without written permission from ASUS. Silent
BIOS/driver installs from an undocumented feed are a bricking risk and a ToS problem for a paid
product.
**Option C, don't build: the safe default** if the owner prefers zero ToS exposure. The tab
already explains that ASUS has no CLI and points to MyASUS (commit 2663b0b1e).

Going beyond A requires asking ASUS (for example through ASUS commercial/partner support) whether an
RMM may query the feed, or whether there is a partner API.

### Rough design for Option A (if the owner wants it)
- **Server-side lookup with caching.** Do not use a device-side script.
  - The Drivers scan script also returns `Manufacturer`, `BaseBoard.Product`, `Model` and `SMBIOSBIOSVersion` (cheap; may already be in hardware inventory).
  - An API service `asusSupportLookup(modelCandidates)` resolves the model once (`GetPDOS`, then `GetPDBIOS` and `GetPDDrivers`) and caches by `(model, osid)` in Redis for 24–72 h. Negative results are cached as well. One request per model goes to ASUS, not one per device, which also keeps the volume small and polite.
  - Requests have a timeout of about 10 s, a global concurrency of 1–2, back off on any non-JSON/403/429, and an honest User-Agent naming the product.
- **Output in the Drivers tab** (ASUS devices only, shown as "From ASUS support site (unofficial)"):
  - BIOS: installed `334` vs latest `334`, release date, and a "Open ASUS BIOS page" link to the `HelpDesk_BIOS` page.
  - Drivers: hardware-ID matches where ASUS's `INFDate` is newer than the installed `DriverDate`, labelled "possibly newer", with a link to `HelpDesk_Download`.
  - Link to ASUS's page, not to the raw `dlcdnets` file, so the technician downloads under ASUS's own site flow.
- **Controls:**
  - A partner-level opt-in setting, default off. Per `docs/agents/settings.md`, its home is next to the Drivers settings and it is partner-level.
  - An env kill switch (`BREEZE_ASUS_SUPPORT_LOOKUP_ENABLED`).
  - A parser that fails closed: unknown shape means the section is hidden, not an error.
  - Never install, never download on the device.
- **Why not device-side:** the 2.8 MB response would be fetched on every device, the request load would multiply by fleet size, there is no shared cache, the ToS position is the same, and it adds another script to keep signed and versioned.
- Effort: about 1–2 days for the BIOS-only version (service, cache, script fields, UI row, tests). Driver matching adds about 1 day.

### Open items before building
1. Run the PowerShell above on ASUS-ROG-STRIX-III and confirm the mapping rule returns `SUCCESS`.
2. Check the Authenticode signer on one ASUS package (only if an install path is ever considered).
3. Owner decision on ToS exposure (A vs C), and whether to contact ASUS.
