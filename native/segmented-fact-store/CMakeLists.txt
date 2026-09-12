cmake_minimum_required(VERSION 3.16)

project(segmented_fact_store VERSION 0.1.0 LANGUAGES C)

find_package(Threads REQUIRED)

add_library(segmented_fact_store STATIC src/sfs.c)
add_library(segmented_fact_store::segmented_fact_store ALIAS segmented_fact_store)

target_compile_features(segmented_fact_store PUBLIC c_std_11)
target_include_directories(
    segmented_fact_store
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>)
target_link_libraries(segmented_fact_store PRIVATE Threads::Threads)

if(CMAKE_C_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
    target_compile_options(segmented_fact_store PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

option(SFS_BUILD_TESTS "Build segmented fact store native tests" ON)

if(SFS_BUILD_TESTS)
    enable_testing()
    add_executable(segmented_fact_store_tests tests/test_sfs.c)
    target_compile_features(segmented_fact_store_tests PRIVATE c_std_11)
    target_link_libraries(segmented_fact_store_tests PRIVATE segmented_fact_store)
    if(CMAKE_C_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
        target_compile_options(segmented_fact_store_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME segmented_fact_store_tests COMMAND segmented_fact_store_tests)

    add_executable(sfs_generate_golden EXCLUDE_FROM_ALL tests/generate_golden.c)
    target_compile_features(sfs_generate_golden PRIVATE c_std_11)
    target_link_libraries(sfs_generate_golden PRIVATE segmented_fact_store)
    add_executable(sfs_benchmark_scan EXCLUDE_FROM_ALL tests/benchmark_scan.c)
    target_compile_features(sfs_benchmark_scan PRIVATE c_std_11)
    target_link_libraries(sfs_benchmark_scan PRIVATE segmented_fact_store)
    if(CMAKE_C_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
        target_compile_options(sfs_generate_golden PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
endif()
