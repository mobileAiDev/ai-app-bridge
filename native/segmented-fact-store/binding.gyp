{
  "targets": [
    {
      "target_name": "segmented_fact_store",
      "sources": [
        "src/sfs.c",
        "bindings/node/sfs_node.c"
      ],
      "include_dirs": [
        "include"
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "cflags": [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Wpedantic"
      ],
      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "WARNING_CFLAGS": [
          "-Wall",
          "-Wextra",
          "-Wpedantic"
        ]
      },
      "conditions": [
        ["OS!='win'", {
          "defines": ["_POSIX_C_SOURCE=200809L"]
        }]
      ]
    }
  ]
}
