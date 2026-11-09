#!/usr/bin/env sh
# Run this fixture inside a WinUI3 native SSH terminal to inspect ANSI/CJK grid alignment.
printf '%b\n' \
  '################################################' \
  '\033[1mWinUI3 terminal layout fixture | IP2Location Scamalytics AbuseIPDB\033[0m' \
  'IP类型:   \033[48;5;179m 机房 IP \033[0m  \033[48;5;203m 高风险 \033[0m' \
  '数据库:   IPinfo     ipregistry     ipapi' \
  '状态:     \033[42;30m 解锁 \033[0m \033[43;30m [JP] \033[0m \033[41;37m 未解锁 \033[0m' \
  '风险等级: \033[42m 极低 \033[0m\033[42m 低 \033[0m\033[43m 中 \033[0m\033[41m 高 \033[0m\033[41m 极高 \033[0m' \
  '较低风险 | 较高风险 | 无风险 | 连续中文词组' \
  '连续背景: \033[48;5;24m                    \033[0m' \
  '块字符:   \033[32m████████\033[0m  \033[36m────────\033[0m' \
  '混合列:   A中B文C言D字E  节点   Tokyo   101-8656' \
  '英文列:   IP2Location Scamalytics AbuseIPDB Reddit ChatGPT' \
  '组合字符: Á  ë  中'
