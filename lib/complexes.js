// 검증된 대표 단지 카탈로그. 번호가 다른 단지·임대동·재건축 전후는 자동 연결하지 않는다.
(function (root) {
  const aliases = [
  {
    "code": "11290",
    "dong": "돈암동",
    "jibun": "609-1",
    "name": "한신한진",
    "names": [
      "한신",
      "한진(609-1)",
      "한신한진"
    ],
    "source": "https://www.modueapt.com/subpage/info.php?idx=1046"
  },
  {
    "code": "11440",
    "dong": "성산동",
    "jibun": "446",
    "name": "성산시영",
    "names": [
      "성산시영(선경)",
      "성산시영(유원)",
      "성산시영(대우)",
      "성산시영"
    ],
    "source": "https://kbland.kr/se/otd/132639"
  },
  {
    "code": "11350",
    "dong": "상계동",
    "jibun": "765",
    "name": "상계주공1단지",
    "names": [
      "상계주공1(고층)",
      "상계주공1(저층)",
      "상계주공1단지"
    ],
    "source": "https://ms.smc.seoul.kr/attach/record/SEOUL/appendix/a11/A0066147.pdf"
  },
  {
    "code": "11350",
    "dong": "상계동",
    "jibun": "740",
    "name": "상계주공2단지",
    "names": [
      "상계주공2(고층)",
      "상계주공2(저층)",
      "상계주공2단지"
    ],
    "source": "https://bigvalue.ai/dashboard/apartment/서울특별시/노원구/상계동/c00000033"
  },
  {
    "code": "11350",
    "dong": "상계동",
    "jibun": "666",
    "name": "상계주공10단지",
    "names": [
      "상계주공10(고층)",
      "상계주공10(저층)",
      "상계주공10단지"
    ],
    "source": "https://kbland.kr/se/c/36638"
  },
  {
    "code": "11350",
    "dong": "상계동",
    "jibun": "626",
    "name": "상계주공14단지",
    "names": [
      "상계주공14(고층)",
      "상계주공14(저층)",
      "상계주공14단지"
    ],
    "source": "https://www.kbland.kr/se/c/386997"
  },
  {
    "code": "41210",
    "dong": "하안동",
    "jibun": "260",
    "name": "하안주공8단지",
    "names": [
      "주공8(고층)",
      "주공8(저층)",
      "하안주공8단지"
    ],
    "source": "https://kbland.kr/se/c/36476"
  },
  {
    "code": "11470",
    "dong": "신정동",
    "jibun": "1326",
    "name": "래미안목동아델리체",
    "names": [
      "래미안목동아델리체(101동~118동)",
      "래미안목동아델리체(119동~123동)",
      "래미안목동아델리체"
    ],
    "source": "https://jaegebal.com/apts/1480/t/84"
  },
  {
    "code": "41117",
    "dong": "영통동",
    "jibun": "957-6",
    "name": "영통에듀파크",
    "names": [
      "영통에듀파크(331동~337동)",
      "영통에듀파크(321동~327동)",
      "영통에듀파크"
    ],
    "source": "https://apt.zaritalk.com/complex/영통동-영통에듀파크331동337동-4436"
  },
  {
    "code": "41281",
    "dong": "화정동",
    "jibun": "948",
    "name": "별빛마을9단지",
    "names": [
      "별빛마을9단지(913동에서918동)",
      "별빛마을9단지(901동에서906동)",
      "별빛마을9단지(기산)",
      "별빛마을9단지(907동에서912동)",
      "별빛마을9단지"
    ],
    "source": "https://m.aptgin.com/home/popup/pp_danji/apt/am7817em0"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "36",
    "name": "강선마을1단지",
    "names": [
      "강선마을1단지(벽산,대우)",
      "강선마을1단지대우",
      "강선마을1단지"
    ],
    "source": "https://fin.land.naver.com/articles/2526330225"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "49",
    "name": "강선마을5단지",
    "names": [
      "강선마을5단지동부",
      "강선마을5단지(동부,건영)",
      "강선마을5단지"
    ],
    "source": "https://www.modueapt.com/subpage/info.php?idx=17673"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "50",
    "name": "강선마을6단지",
    "names": [
      "강선마을6단지(금호,한양)",
      "강선마을6단지금호",
      "강선마을6단지"
    ],
    "source": "https://www.aptbong.com/apt/danji/10965"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "65",
    "name": "강선마을7단지",
    "names": [
      "강선마을7단지삼환",
      "강선마을7단지(삼환,유원)",
      "강선마을7단지"
    ],
    "source": "https://www.modueapt.com/subpage/info.php?idx=17683"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "63",
    "name": "강선마을8단지",
    "names": [
      "강선마을8단지(롯데,럭키)",
      "강선마을8단지럭키",
      "강선마을8단지"
    ],
    "source": "https://realty.daangn.com/articles/4465288"
  },
  {
    "code": "41287",
    "dong": "주엽동",
    "jibun": "6",
    "name": "문촌마을5단지",
    "names": [
      "문촌마을5단지(한일,쌍용)",
      "문촌마을5단지한일",
      "문촌마을5단지"
    ],
    "source": "https://zipnara.co.kr/property/25968"
  }
];
  if (typeof module !== "undefined" && module.exports) module.exports = aliases;
  else root.ComplexAliases = aliases;
})(typeof window !== "undefined" ? window : globalThis);
