'use strict';
/**
 * 内置设备链池（系统内置组织）——**自动生成，请勿手改**。
 *
 * 生成方式：node tools/gen-builtin-chains.js <ks_persistent*.txt ...>
 * 本次共 61 条，来源：ks_persistent.txt + ks_persistent2.txt
 *
 * 为什么要有内置池：设备链池默认是空的，新登录的小猿账号拿不到 ks_*，
 *   PK 出题会恒定 400。不会用设备链的用户因此完全跑不起来。
 *   这批内置链让「没有设备链也能用」成为默认体验。
 *
 * ⚠️ 安全：这里存的是 ks_* 设备指纹（device 级，非账号级），仍属敏感数据。
 *   已落库时统一走 cookiecrypt 加密（AES-256-GCM），不落明文。
 */

const ORG = "系统内置";

const CHAINS = [
  {
    label: "内置设备链 01",
    deviceId: "355436623",
    cookies: [
      { name: "ks_persistent", value: "W5LCM7dp+1bT/HVCO09JlSMhU3RZ6VjuE5wN8eb3SQfXK8XnwBEX0UE7jowiY+O2K3b3yChWYgqSNQaYpIf585QgmSUDPf+TPyzIfmU+SrU=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355436623", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "pbgqRXoKXhia1/vnFfSMMgqUJFOjxGGOpQEenYPCcZc9Xc29fHu2LUwDmD7qkVJq", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 02",
    deviceId: "355436619",
    cookies: [
      { name: "ks_deviceid", value: "355436619", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "T2UWVHNTVjmuYmpeBErZYx/vUX8rBZaxaMCwGZDZ21XRFpZEgydzIG77mP7JrNE/", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "WwkzEt9dQHreznJs0YTxmKLviyBhGJGAN7XWxNDvpDu9JyMpvxtDTs4Sow6566fJXdzWaXbEm9GZSqApYyaIBMhuTw3PP/WofWxEcuVSEPU=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 03",
    deviceId: "355436621",
    cookies: [
      { name: "ks_deviceid", value: "355436621", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "o+ME5pczIFXTjDgxl4S3DOWI5PqUVVJ3xBvB1ej/XAcdGLHfyjAnf4kUHm0DpMIS", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "AyCJ7bviAvbIQSm47wBWg74H/cnsKtblqebR/Lf/NmM2jW9s3tKS9cuCGRoky8eEXM00Ah5+y9Xo/9fYwya/bslv6EHgxx667dk/VatHTnM=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 04",
    deviceId: "355436622",
    cookies: [
      { name: "ks_deviceid", value: "355436622", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "n6DLemALNIj86xSc4J3/5ubgb3UOUTyAvBEiITlSnLnSgYp6CF9VS0eprzgLYDcI", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "vSeaZKf/XWPv6UW2FYY7lacW02lP79opZQYLl0f4f9uWoU1EoVL16GctthcNUPbPSXuaUj5CvfmmLgFapx6aFxKjX8H1KCp0fe5VsDDTACw=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 05",
    deviceId: "355436616",
    cookies: [
      { name: "ks_deviceid", value: "355436616", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "5mYrgsntBQ6XdQtbv6Sh6ZMk5hQrObx/FtPUc01TJLY0Eb5hWbri6U8c9+1st0NR", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "yDb8rIWLZ+/b9VwnCz3dBF6wjRZbkWrX4KzVqfWXE59RnKDEvxqZSjDdUYIxj+ryG27FKctRVRL4zeO1f5pzZAjRe5786liQ9gznNJSa6qc=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 06",
    deviceId: "355436617",
    cookies: [
      { name: "ks_deviceid", value: "355436617", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "2vKnGr1M+fqvubviPTIHi4uenmjUvpZkkdZLOtkY/seuKl+9SgbKQyNSLscXQwya", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "GT2GXULz+tNay/C+22A6Xk0PxiiZcxi98awCAEe+/dxRk5BtQb43nmcbHC5mfcWnyPplbFNDH89aqE0oO4Twb5pT6ibtStCqoSTIY2Ha34k=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 07",
    deviceId: "355436618",
    cookies: [
      { name: "ks_deviceid", value: "355436618", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "Zmn0qSL5cisj06a/fAyWl9h/88b63xmOum1fTuu8ZaZPC08GLF8RM+8DJ404eEax", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "30YfUphbwT9ENl+Pwegp0iaX8Jz3cl+/rE5NXofobgWuqfN6uH8HeMVgZq8epwDZPm3M/vbMBKFPsC8849Tjpl5GGLzI/GYAbEV+QVkc2+I=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 08",
    deviceId: "355436620",
    cookies: [
      { name: "ks_deviceid", value: "355436620", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "pd7zpwh6IfNk+uGRfSsa+BxX7Y/0TvO2MscM2Inp3KByQDseF+FTTkR3UZjmIigU", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_persistent", value: "Iin8N9QBOcXj2cPkAvuj951WtxkvcT3peDpWpkwKF4pYRTq4fO4hM9qFOyjdXejqQl/QP9UANGTj54VPDgWhXuY7p9gg0P+8XoGrTadMfcc=", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 09",
    deviceId: "355438083",
    cookies: [
      { name: "ks_persistent", value: "yAzjAoVOWtPhqJkWlfqFU+ajsZPcJE8RtAAAaHRaNrPXwqKSpXHXNoWW8mapN/+0IeS6Ix15E7RffWHp/G0F0/bHBPpp1Nr/JLi3WxEvVAM=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438083", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "NZVAyze7xoG7t8FwKqp5Eo66A8BKFjeIqw+bx5zESx0gNDWCJPEJ98Rg8B4OUJww", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 10",
    deviceId: "355438087",
    cookies: [
      { name: "ks_persistent", value: "0Bc54cdin10FhKNRqTk/sisdQWzvyELXk+8ZpMioi7DQAmM83oMoczLYy/D81oct7V+TJpQjNlr5iUvRacp8AQpTuyiBjXBzTLl9Fu6Y+2w=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438087", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "cUALev7z0vVgZUpUvsGGoleDgpURT2JJNGKLjMPVz9GlKR3eOfpoii4NFdWn3oto", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 11",
    deviceId: "355438084",
    cookies: [
      { name: "ks_persistent", value: "g33XcY/Bymj3GhVQi8B5H6Fbm5uGO/MGgZ1DFXkKVHQDfQdQwHaK4ThesU63uDWkIB+/1wcl3FOAPZjTME+PN+71xK5Q0YEEJEIiGgJkBS4=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438084", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "RD8zyiUnOdBNQSkOj/2sm5l+E9dqK3BJioWvbv0DmupF2coBpnVqV67Yyorxn+S2", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 12",
    deviceId: "355438080",
    cookies: [
      { name: "ks_persistent", value: "tKPO527akbHH27h01/jYhPmKkV5Mg/hLlhqxVTUUNBQAFjJetsAVP/qZxjQLqe3xFpoAWzo7v5iniw33tp7LYx/Qsce1tqGe0jylD8VFJEU=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438080", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "BXUWCh2J2qyTA2AUgQapy6/vcRrfGRY1uKPw2OyUuqMVaWtpE3ZmKPpMns6///5B", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 13",
    deviceId: "355438082",
    cookies: [
      { name: "ks_persistent", value: "eU0/ICGlrG5bh0v4qXyr2TRUc7VDCMWld7/pJ8y38TZ77c8Y6PpXBiRMkftXOwHgUJddC9tSENK6LnSrMXiBnZIXoy4zaQ3Zvik7w10/jx4=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438082", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "OIEHKM3OFma2zj5qjHbeGS5Qxjx/O22fNCbgEWqBFszi0u/1rO/lWjpTZB3fkIXZ", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 14",
    deviceId: "355438081",
    cookies: [
      { name: "ks_persistent", value: "cHj4yw5JQ5DpdRaOSR8fTYJLv1cTROad0bm+p5rn49pp5Mbyov03zFDBk5ER2hP5NzNzz+rYxAm8LUMBFtpU+vPYskq7oIJ2xu+maVHXL2w=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438081", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "6uIPSkRcxeadiL/GKVxDsQ8/yDrGI30vjiqmNNxON6UviruvfBY2p2OQjH6LOzyv", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 15",
    deviceId: "355438086",
    cookies: [
      { name: "ks_persistent", value: "WlEjJRgkkSlw+p0Q1eusG5XXDzudTmRnck/rYxzX0g4Cf3/d5cZvYwfx+AOUBcdznX5/B2bL37Ssbb9yJ1GaDTS0LIoJcFVIPcK+FuAADNg=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438086", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "KTED74qebNGp1x7SKt5ZmRp5UCy02hcInTjDLwJbHef/AkYRcjB7UH1yHUjE+Wkq", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 16",
    deviceId: "355438085",
    cookies: [
      { name: "ks_persistent", value: "QmpZPa5fZpBcO5Fp/PZNkILHj6LffJtBBaN0E3MukUsVwOFMJ5SHYY4sIzLJ6ZZEwRyH0DPQIixD2Atk0WnvzSOPXqjM38OihqqF6fhuCAY=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438085", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "2O65CKwb3Urv8pY4b8JwojWWPRN8CdFbECzWhrt0o5mKnYFfhd7TOrGJBKyuUdbt", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 17",
    deviceId: "355438826",
    cookies: [
      { name: "ks_persistent", value: "bkmCBwHpxxLSI+aoS3duxpdbluVnIFZTSCW5PdjModMHzm3WZz5Fuw+0PBf767piPvfEVsCyL/U2HfUCeXknUV8Ly8Sr/omd6vTDSueeQz8=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438826", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "VHs3y8BRH42sgdujyxtH4PioA79VDzMIe9BR+vyEGFxtgILGrPOaNsLn5N2y4aL3", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 18",
    deviceId: "355438833",
    cookies: [
      { name: "ks_persistent", value: "R926BnoC6iKK1wN+E53zigc57zn0P+uO/8i8PYBLfSDl2yhp+augBjo6qFwxrVruDpeqxC4d9mAbCGtLEhz+YU9iA2cnEimb0HRMN2cLWEY=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438833", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "LLKKlcBcJbFinnNxXV9nenQzTqpDsA4jKJxZh+obMSeoImsD7WKCjfL6zv1ebriJ", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 19",
    deviceId: "355438830",
    cookies: [
      { name: "ks_persistent", value: "9WjTN6/6dY6zTnr3L8FU20hGqnhhIg8xy0ikJ6IOsP2bYMHZPaq37wzcIy7Sv8BdBOcBmLPcS+UaMlDBrMR09DhkYdZhRg965kq2W8jBzV0=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438830", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "r9pYqJzCv9O7mDZ+ajhS789I8hXc1q7WbMrG5hG2FKLimVFxdn0y7xNzvkdKNKO0", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 20",
    deviceId: "355438825",
    cookies: [
      { name: "ks_persistent", value: "hR8wTS8l4An54Z8NE7rpT6TBQgPXVMa7AneDYuclk5t0aL9OEqkMMmb1ZxZdqPjCOqmba6pjbUFbRKqcapkX9Nldmqcq2k1hDSM1s2t2TdQ=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438825", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "oHKMJ4iMSn80epCMd7gs7OioKUngI7vr0fo24Jm8PxBZyRkRPqkE1u2/GqUiMmAx", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 21",
    deviceId: "355438827",
    cookies: [
      { name: "ks_persistent", value: "TsT+gWYC61IJ7dwhJ/s0y41HjkOcMwpYGEjivJDunqvDff3Zt7Cl4Vk0liI/Q5dKliQNHx+VX+QoXTn2GzUmZQAf8kdOL2hV20nYw6D9Iek=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438827", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "UOsW2LvoTcEPHvhsGzWXcDzcIuP4GWknou6MqXojGH1sUTO/18Z3LMSpz2m3suyt", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 22",
    deviceId: "355438824",
    cookies: [
      { name: "ks_persistent", value: "u0TxZNulakhheJJ5auVfhzphSbDK5K9sKfDzcZ/J/ztM0hUp22P2uevqLHKkz45okJzujzPcuU1LeNE5ShBUkjChXzJMg+AIR1fmkNwWSho=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438824", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "BXykby1ix1Hfc2LjrNuTewZHSQoQNY336l/71l/ICLNSt34CncTaepLEONvEjpFD", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 23",
    deviceId: "355438832",
    cookies: [
      { name: "ks_persistent", value: "QsxkIvGKL2Lx1kyTYQhs7jXEjiT3UrgY3IFgAFJVTZT5CZ5cB8+JuifMMBluJiiBoFgTX8yfP0HmVgXlH626nDR/Cv27/WcJawAlLjST42A=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438832", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "zsVtIjnRh4kqADeCHBhxXR2bz3RPV66UODrTLipltt9Tp10zHjUJobCoxTixpen6", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 24",
    deviceId: "355438829",
    cookies: [
      { name: "ks_persistent", value: "1b8xRFjW1T/aVqaiFD41vvdJ7rVGPSlovXS9LldhlZ0jBVzgHL+h5PaKS1/2AP4EGiJidEtlGRB7C3uCV/Bch/B41LISY2KL9WFRUfA4WQo=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355438829", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "SQ0ajT0/rZ0whTbi+KR1TSoV9WMsjDxQXBLeRA8hCz2TVJO8Kn2K9M8x4TqniybX", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 25",
    deviceId: "355439472",
    cookies: [
      { name: "ks_persistent", value: "v8ITg4e0dcgRUW/LI0WGYDTPzQke5eUs3ZKD169IBWdfBToG66i3OHlP8kMEyu6UvnBeY9ePoef4pA5bdhZDu0mitJKVckkdKcb+1kPPXUc=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439472", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "T3MpDAt9Z5JXZSDA2155u2Iv3pAq9OpYq8EpKH9s1w/MrOOT6JoQ68vOtn7JAJ/6", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 26",
    deviceId: "355439476",
    cookies: [
      { name: "ks_persistent", value: "Om8NrjR+dIYTNMQE9Dq2/g6GsPl4pD6Wfz+k3VIyesUZeW7XPgB7S9hqqJUx9JPr+EWejyI3qsOr1OmycFCEg8zRPGapWkG5lgph6N7z2NA=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439476", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "wGt4Ngl/1MF63D+rR6XiXMRPPoR/FaUMIgHKF57d7Ev5F0q9UGTyQEBgNl54jKqe", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 27",
    deviceId: "355439473",
    cookies: [
      { name: "ks_persistent", value: "4xtGAqh38eYoT6E3LifrtbcyU56XseMtAMK6q+La4cNLkeGDeXwrg8YG7ubH9j1Un/kms+cHWtHPbXWKZqlx/9oiDxWM4IsCnI7mcbATbvA=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439473", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "+55Liksko8QuqP4K5cxrfMRUKBDIsD/vtPx821Z0r+X2mMFVAzNw7uxRP9fR4Vk8", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 28",
    deviceId: "355439475",
    cookies: [
      { name: "ks_persistent", value: "iUABJcFvczCWze1OkJ6bSDevBP3hSD+lVKtTFjKLbzhZuZGDUbZzTj/nCZoI9YYsUIC0nGAM0WUWXFT0t9AU59lleiZHuuGMNnfJfVMsyY8=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439475", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "Ao5+KYLEWdKjOb/NR5JY0AkUFfLgTl95Kth5SdpKE676+xjbYrEer46vaaFpuCL+", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 29",
    deviceId: "355439474",
    cookies: [
      { name: "ks_persistent", value: "KTRr8SBumYVOgZsvG5sS8KlQ7VUTBk1HUTOBV+SejUXynWiz/A9skGDjU9g37OdUTu7H+2Fbw2yA+mBdmd7qnCCzN8zRWXRh4864OC26g8U=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439474", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "FeDiTggunYQCgdww2+CWFPP9wyBiz6l0DHu42g2f5bHovUgX65RAWp31Lyr49vjW", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 30",
    deviceId: "355439471",
    cookies: [
      { name: "ks_persistent", value: "vVI29xuhy6a5jDVxjGUdONSddsDMa5pzrdqZ4elusOOaYYGEvoWDZwJnDooVpAgiNMp2CwY1D1VfFZl6Rp+UHKBKskJ8uM4AMN6NvSUNjXY=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439471", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "I618uVWnl3GIpld7chVA6jLJZFUqvdOweQNyr/VJLDbJ2YNYm/i12+YPUe33l7hI", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 31",
    deviceId: "355439477",
    cookies: [
      { name: "ks_persistent", value: "IpDgW7C67+o9gVkz8MyVOazTEXwEsQJL6rn38IInMn2uMDdjDWbr2faWL2X+sw37wtWQ+pWtmhM+EDzXd10VmC+PTKPndBqwD9OxvfqhHbo=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355439477", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "flTrzTZobicuRRZxO4T7yBp6X9USeyuyEQ2vUQKmSJljYS9IUBfzS8OPGOm7lWmM", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 32",
    deviceId: "355542922",
    cookies: [
      { name: "ks_persistent", value: "H4SROnXoSEX2mK912Y6W+aZTd70ZI79HFcqgk7qrLS/TqNiH/Bq9ErQA29F7shhs1SYPHiZOYtCpaHU0pz1icaHS7wQY3ZV4H14BRBf1xeA=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542922", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "Pr5+m5jUhusWJBpBa9miTLNSbt7zikJ0jGm1Az9yjbRmBlEqzOj3en/JV6nAwdH+", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 33",
    deviceId: "355542920",
    cookies: [
      { name: "ks_persistent", value: "LYwWwAMhKD68y0ddbuF3J26VpbRsf8jGNvoVrVAwAvMD9YH38Wv9WWbO49qQ7EEZYFXjVnOonkXy7J+R/CYvXUEBrv388nIchQIo+5bXWpc=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542920", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "0w9nPnURlsqyBRz6QkIkNErzV40L6Mstx7ZtEmz+k2fZKpYTqVmsURjIwYZyvmCZ", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 34",
    deviceId: "355542921",
    cookies: [
      { name: "ks_persistent", value: "vZrf+NZe+ruItNDpp6D24KFkTbJ0jVKHBzL+Sw1U/0HKT5MeLSxgw2ODu12IJzIQy+X6usJYiFElIDY9M3BS4b7HqR2sVvTCzibiFjxP7j0=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542921", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "sdwZEfOdK5MW9zQ7LXwlu/oqICVHupS6qmB4E1muXFVe/FLJCb+GUhxND1vDNZQG", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 35",
    deviceId: "355542935",
    cookies: [
      { name: "ks_persistent", value: "VimctTYBpD6o+qdR3+7uqitsDK8F00kkrzOA3x8bVS14dYXoFjv2+JnKO3OOsoGx00pA82u1IE0BvJRDSMtdb/lwGmUhd5C03WtuJ2qsJds=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542935", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "Rm5Sz+15b2t/wfIfPk3U6h8+T7BSd97nOA2HUvPICl2LX3mIYwzmgkMV4Wd41aX6", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 36",
    deviceId: "355542927",
    cookies: [
      { name: "ks_persistent", value: "fbKeKtSedCHg5FeypOsV7wyCFUpqPnEOX4O7ZCmQiU+NJ/GgdaJnAmbpY52GXIhPw6OudnuClVnZpUQc2NVnAAjVx11Y5tSO4ecr7KCw9jQ=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542927", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "Z5N1iSo6fy7HGi8Ov47V0IKJDNtnWyKHii4w2G1yex0W84WZuP5zyeMc7rvy+vSR", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 37",
    deviceId: "355542934",
    cookies: [
      { name: "ks_persistent", value: "aoAqF2LJpUZgXIiTs59LDPdai7nhIl/mXcBpx5wMIsM7hHxIKjaiyU1Vm6lIou/NXxegC5WeunGqRTiBG16EjaWz9fDAg29ZBSTJkVwcHuc=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542934", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "XAzQk2yJgs1c6pulATEYoUEbXEshOUYXcMTSQqSHJ2LsPXMi5yKrqZXG/z96tIlz", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 38",
    deviceId: "355542939",
    cookies: [
      { name: "ks_persistent", value: "HYUtulhXRTa2ohmLVqaN4zXh/4jNWoh0xsqjt5Ukxn7A6EshbkRhs0/o5JSlelCCAI6/0tRO2v/hhP5wIA7vT4NVAFW7fGHwXCABhbQv7S0=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542939", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "dawkpr2FJGmia4euRim/hZcAlKp9GLLOYB9q0F2ZFO8bHpWcCMvpYcK0lI+sUjDv", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 39",
    deviceId: "355542936",
    cookies: [
      { name: "ks_persistent", value: "PDxwKFXvFX/5mlNmYfAC+AmP+I4pLcNwIH8Vyv9YduAMqQ+cgSlJAzPo1gLpZtAmQTURzcd5p2dFrH97Z5VKiBwVjIjoAX8xzvzLb9nvKOE=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542936", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "dJ+MLlya/OWGP9BE31BaweM/2T+08BzHZLAOZg0X1onDWOG7j7HECycVozFv6rN7", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 40",
    deviceId: "355542928",
    cookies: [
      { name: "ks_persistent", value: "P/+1/ZgPyRNg3U1RTgcHSwMQGSrDGFllfJlxJAVQxKdGZvK2J8gxb9C4cDyG0n8qfO6CuyQMnlYJ0VEqM7YyJO7fDPHkAuIIQ0a8Gh72848=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542928", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "ab6aWr5j58kjFwMc87e0iqTZgumUr5esl5nQWs56EzGhU2afuAf+3tNL9rgslaop", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 41",
    deviceId: "355542930",
    cookies: [
      { name: "ks_persistent", value: "VlPJHhK23wduSXrG5fVYOnfldssJfoaiKeAFqvIfg36iDb+/l+/1+6q6PUe5LQFv/pMFmEreeyfZ5nu7ms2rNl7aSFn/maOfUiZbcHlpzb8=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355542930", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "pZ9pKaXZ9cAAhy7NuA877a4zmg3Oan4+lBRwz0Oi2wD7Kwio8aGeTo2YkOMpsw4Y", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 42",
    deviceId: "355544037",
    cookies: [
      { name: "ks_persistent", value: "whBHNZl+bSNsEtcklTRxslsL5Iqgltxc+/sKyxYwGeaAs2jlcgk3keTNIRM0gB9aHDWavG6qzNOzA5jzuxJzWGyyY7ZIuW+m5aAbdiz76hk=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544037", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "MeWG9A0mfBx0M5ccITnqoPi3i1WkyNJLFfrOjtE3qeMeaX2Bdad7aGLZ+zWFqbmj", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 43",
    deviceId: "355544042",
    cookies: [
      { name: "ks_persistent", value: "4f2aGdlYcc4yDSgLvglDowtZMndZvTilwBNakAVaF4Uk2WG6KsbzlNAC8R0o59eBPs7DIAnlRPpyAd+E05cRDJefJnNQd/XZspDM1w9UH6g=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544042", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "8/8Iep8IblwPIBoYBcYiAmkesbhFU8lNyH9oyWhSbKe3TT1KtUNQ5Z0bOG/Nrl+s", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 44",
    deviceId: "355544047",
    cookies: [
      { name: "ks_persistent", value: "FHq+ZnhVCk1qPygfqHTpJDXtaFXqe4NpzdRs4RMeamMDwczlAMGMNSA1uIXhP78UZSVA7gHRLv7TAUp3PoDplvIzrrZnO7JP5eXsk35rg9k=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544047", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "lLxgUq57PiYB3kQ2qeqsN3z5+xsrIA+AwgK23stqyAG1VYdLGVH5tGcqwKjAwCw6", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 45",
    deviceId: "355544048",
    cookies: [
      { name: "ks_persistent", value: "9Jj9KA8XztCBvoAvUgZfLzyHIdbUesI7E7Sdhd3ARTGC+L9ppp/MrJrn4SoVs5oCjJEEBLtMuYm+c60iABEuVP2cEEwOTVlqNuUAj2yD0ic=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544048", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "eq4pN3vCq8ERkUmBlaXhw9KbR7KgpQeeTF9T+9cvCG57ppaFHgyAdLRRmSeNaovs", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 46",
    deviceId: "355544049",
    cookies: [
      { name: "ks_persistent", value: "286Nf1fumTMfpuVwW9RtOiH7WSdW73qleAHovw3Uk9kTAlAlE+nkJ8BG7ql8Fvz7IjvlSgSj06+zMlLEXrOpYxsnhUHRrK8Yi0VoTBBqcVw=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544049", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "uEGUnHBKbJsDmb8QyeFH/hfARRQs2NzaqwrKaMj9I7uBqyIwo3Kn1Y4HTewNqavR", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 47",
    deviceId: "355544033",
    cookies: [
      { name: "ks_persistent", value: "FtsfDpBNO6opRnMKwpxWnVgNs38HXB5/sgXmE6W14jj+2824vRWINc5yBDpX5BF1RMo7NY1O2ZACIVKwEjQ8fnhYzMSiZK0jNyF2TYR9GuU=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544033", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "llJrsQv847aOvNkpm6L8avF9nohhIG+HKa/HDEmq1G4ldDc2qTe2wDRu3/m+Dd1f", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 48",
    deviceId: "355544036",
    cookies: [
      { name: "ks_persistent", value: "jjFBsAPjQ9eP4BTwgoxw0Tn/oYhaNsD9QsBuNBGGnpK89k19hvWhdRvU9GLPr5tvSlxlVE0RzV5ecBPYWWmd1lGDkH5/b7vWrBefo6PNsBM=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544036", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "jh+hQ96nwt/HQ5/jdycEVoi6KgxZU6+iyo8GoCX3QBMJTLYSOU3DZn1SKfaeWYkM", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 49",
    deviceId: "355544031",
    cookies: [
      { name: "ks_persistent", value: "AWmG5EFXB8r/svBCfVv1Ka+RHOES/YYqEAKXwUih5Rh8GaG9lH3ftpeq0TZDMZzS0kPPueI/fSOlFZoWpQe1xtBgKFZ0kuzD7iaF7POHyXw=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544031", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "IwHqWrYpvBJrE3NxCXin4mVanizllwsNHYk3WkfRx3u8nSt1XzDsEvI7Z4+IA2yp", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 50",
    deviceId: "355544025",
    cookies: [
      { name: "ks_persistent", value: "WS8uOEh35wcuwUJsVmbTY376TjYKItd7op6408gdXYenP01tSJWrYPn9yuPuFvYl3Odyk8z/qVC0OVDFYEM5c15F+CNCiUQDoYyxktjavec=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544025", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "DdjbB/48iCImlGzYUcgeddy7A48I+Ik5mGuEGCIX7K1zIfx4dG/EYpBg3IK1EpOA", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 51",
    deviceId: "355544029",
    cookies: [
      { name: "ks_persistent", value: "jKXFrfhQstLvS25sSuhjdaz3CxFH7fl2z58wn+gxZHHGd/8LU0mQu2HJ0DSKOVdy5FXcLsAY296HREDJfN0wYib/+cU1po7DrmO+NJEmxFg=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544029", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "JmhExb4QQpH/glPt6nk96e3oSU+KgI2H6c40zL6vgpnT6CWQDgTua3nnExRjCYDe", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 52",
    deviceId: "355544831",
    cookies: [
      { name: "ks_persistent", value: "OekuqDjcvRoOCzjbuAy5kLshQ2dTQ5qOjZvdqbsQ1y6lBZUcbfvn1dKEai0PY8sfryYs9xhgm/HuYQkSK0QarFCWvD4HvBqcdCH3cJWkpuo=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544831", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "4CXAm11miXwunJrKjYgsz45FfuSur9d2XOG7gvU+j9TaKeHAp49XYNE9zGqJ+hqH", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 53",
    deviceId: "355544846",
    cookies: [
      { name: "ks_persistent", value: "EOmtgz3TSyaTrFgnTj0l+rmfwnGlpPuLnuJKjuXN8Gugvzi2tQsZAW65Kk978LVizXcAEqnFkC22OKNHWEVNLFr70SjJw3CcoaMBjNEDCN0=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544846", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "GQHrx3m2yyWq4JQOdLfjUo+cMvaUdEdJ/m4wpeHXR2pq3v6b4/XhCNLNUEhX8A8W", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 54",
    deviceId: "355544862",
    cookies: [
      { name: "ks_persistent", value: "M7XfDJJz0o9ZRxi8vpt1B6G+KbjxyqKDDPAJksBU/s4s8PF7Poey1Q/Rw2X+bqBlrGqjuw2wLdSl4lBsLD+IIJXIdLvvtJW6mKAkkHoiV7I=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544862", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "GxFZk2l9lIHAIzAohfXtTdiE/fqufNzPVXuKf/YdMYvndpv5j2QbpbKTJ9U247fG", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 55",
    deviceId: "355544858",
    cookies: [
      { name: "ks_persistent", value: "VJxODeo72kaOib7G/6/ZTreLnmMwxyST0qmJtx4pt/hR/u4bRji9o5aE2E0sXyy+2HcIOHNcKZa7xDwEGFg6Hkrz56vzbMgUz6qWgLq3xnE=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544858", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "1zdngaBu7AufUVVvdUCeXRNhcSyxnq++SVL8si8VE3P9xcnPkmjcje1vm+mce6B5", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 56",
    deviceId: "355544838",
    cookies: [
      { name: "ks_persistent", value: "LSz5u3nneUGzBm5Ch0Snm6KP/pRtyw7T/xj5t1XoN4seudA6JY2a9HqYYS/TwD7hDhoUqcacyuP8LjaZUmbuc4Ol1h/LegnhTbZYKbN1RmE=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544838", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "kgQrNSOj9MZ1tpH91WCMvNd+ZrbpTFgHopibAe4qM/fPgWoPwVSrReLu1+4FdU45", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 57",
    deviceId: "355544852",
    cookies: [
      { name: "ks_persistent", value: "/X3q+bvBjogojhE7r2tt7fWtv8J0jLDWwwgNv0ztnqV1q84SEuv+nVi1/FtiMBZHnNS6OH/flx2Bg+R1Di8UykpCiNapTxGERXShktCi1H4=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544852", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "6bVoNt9ZLi5/Yw0Q5SfBdShbaUWQecONLbFbDUTtKEh2r8AHlLX41LP37AKHjtn0", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 58",
    deviceId: "355544833",
    cookies: [
      { name: "ks_persistent", value: "j3asa5rMJRUDkp2/D8f95px62dtkY4BQyk36KVhWBA6bbEoGifK/XVvQ2fXTPQasfFkhSbMMO30Nf4BvLmQexJ5YHVmiCx7HFElkTAM+Jys=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544833", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "MCnGcM0cwrxyDfZ756cFD8z/v/HHlrfXV/fslYcPkoa74XQUQ6Zb7kLmn1encKLA", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 59",
    deviceId: "355544840",
    cookies: [
      { name: "ks_persistent", value: "vm3I6eAv2K1urlyNhoRlJ81bR0yOpAEM3TvhzS3JkeLdqVSE+5vANb80YBM9DZ1eaf3RN9nKQ/QovpkDFSP2EunROp9X/hjJXXBnWRZJN4g=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544840", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "kLD0StabadNhVuMKCqIIJdSZe2p56y1FJGxFVRJ3ZQuqIp1XJ7gt/xY40j6wEAQ5", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 60",
    deviceId: "355544841",
    cookies: [
      { name: "ks_persistent", value: "9P4ReJ+DMpH/fZeQqwKvQQ8Cs1hntUvkBUs8w2R613aZvI3KMmvqpiLg+vXpSQamkGN5PmVPz8rb1EFZxB5IuOd4OxqERHYEbgWTFDRB8HQ=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544841", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "PafQuNtGNdMsiCBE0/cdNLKellTXkUbJ0wElVYJ08oSt7Py5aghJrkQDk2zog31l", domain: '.yuanfudao.com', path: '/'},
    ],
  },
  {
    label: "内置设备链 61",
    deviceId: "355544829",
    cookies: [
      { name: "ks_persistent", value: "41FBVyjQ+Dfb6zsCX5CjfLvItq9BppHzWJNoWguVSqhVKzqtde16zhTRL0hpV2O6yJXuXsJUb+vvReIlrYzqFGtw+uNIbhK5HO0VyO+ufhw=", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_deviceid", value: "355544829", domain: '.yuanfudao.com', path: '/'},
      { name: "ks_sess", value: "o+TRcSMbdY23XvKdGOIBjijH21rb3gC5/Z7opyYlIFBwB9JfJszfUjNOIdj+FKXd", domain: '.yuanfudao.com', path: '/'},
    ],
  },
];

module.exports = { ORG, CHAINS };
