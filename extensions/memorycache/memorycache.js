"use strict";

var MemoryCache = (function() {
    const PAGE_SIZE = 4096; // The cacheable unit size.
    const RETRIEVAL_SIZE = 4; // The size of the element that the page is broken down to.
    const CACHE_TRIGGER = 1; // Number of hits required on a given page before caching.  Lower is more aggressive.

    var pointerSize = undefined;

    // Holds hit counters and pages.
    var cache = {};

    function clearCache() {
        cache = {};
    }

    function getCacheEntry(page) {
        var pageKey = page.toString(16);
        var cacheEntry = cache[pageKey];
        if (cacheEntry == undefined) {
            cacheEntry = {
                hits: 0,
                memory: null,
                error: null,
                inflight: false,
                callbacks: []
            };
            cache[pageKey] = cacheEntry;
        }
        return cacheEntry;
    }

    function getPage(address) {
        return address.subtract(address.mod(PAGE_SIZE));
    }

    function getOffset(address, size) {
        return address.mod(PAGE_SIZE).divide(size);
    }

    const floatArrays = [Float32Array, Float64Array];
    const unsignedArrays = [Uint8Array, Uint16Array, null, Uint32Array, null, null, null, null];
    const signedArrays = [Int8Array, Int16Array, null, Int32Array, null, null, null, null];

    function getArrayViewer(size, isUnsigned, isFloat) {
        if (isFloat) {
            return floatArrays[size / 4 - 1];
        } else if (isUnsigned) {
            return unsignedArrays[size - 1];
        } else {
            return signedArrays[size - 1];
        }
    }

    function loadPage(page, viewer, callback) {
        if (viewer == null) {
            // Some data sizes aren't supported.
            return false;
        }

        var cacheEntry = getCacheEntry(page);
        cacheEntry.hits += 1;

        // Callback wrapper that takes the ArrayBuffer/error and calls the provided callback.
        var memoryCallback = function (memory) {
            if (memory.error) {
                callback(memory);
            } else {
                callback(new viewer(memory));
            }
        };

        if (cacheEntry.memory != null) {
            // Already been cached.  Just grab it from the cache.
            memoryCallback(cacheEntry.memory);
        } else if (cacheEntry.hits == CACHE_TRIGGER) {
            // We've hit it enough times to cache it.
            cacheEntry.inflight = true;
            cacheEntry.callbacks.push(memoryCallback);

            JsDbg.ReadArray(page, RETRIEVAL_SIZE, /*isUnsigned*/true, /*isFloat*/false, PAGE_SIZE / RETRIEVAL_SIZE, function (result) {
                if (result.error) {
                    cacheEntry.memory = result;
                } else {
                    cacheEntry.inflight = false;

                    // Write the array to the cached memory.
                    cacheEntry.memory = new ArrayBuffer(PAGE_SIZE);
                    var view = new (getArrayViewer(RETRIEVAL_SIZE, true, false))(cacheEntry.memory);
                    for (var i = 0; i < view.length; ++i) {
                        view[i] = result.array[i];
                    }
                }

                // Notify everyone who's waiting for the page.
                cacheEntry.callbacks.forEach(function (c) { c(cacheEntry.memory); });
                cacheEntry.callbacks = [];
            });
        } else if (cacheEntry.inflight) {
            // The cache request is inflight.  Wait for it to come down.
            cacheEntry.callbacks.push(memoryCallback);
        } else {
            // The page hasn't been hit enough times to be cached.
            return false;
        }

        // The cache should suffice.
        return true;
    }

    function readPointer(address, callback) {
        address = new PointerMath.Pointer(address).value();

        if (pointerSize == undefined) {
            JsDbg.GetPointerSize(function (result) {
                pointerSize = result.pointerSize;

                // Try again now that we've set the pointer size.
                readPointer(address, callback);
            })
        } else {
            readNumber(address, pointerSize, /*isUnsigned*/true, /*isFloat*/false, callback);
        }
    }

    function readNumber(address, size, isUnsigned, isFloat, callback) {
        address = new PointerMath.Pointer(address).value();

        var viewer = getArrayViewer(size, isUnsigned, isFloat);
        if (!loadPage(getPage(address), viewer, function(view) {
                if (view.error) {
                    callback(view);
                } else {
                    callback({value: view[getOffset(address, size)]});
                }
            })
        ) {
            // Fall back to an uncached read.
            JsDbg.ReadNumber(address, size, isUnsigned, isFloat, callback);
        }
    }

    function calculatePagesForArray(address, itemSize, count) {
        // Determine the set of pages that an array spans.
        var lastAddress = address.add(itemSize * count);
        var pagesToRequest = [];
        var currentPage = getPage(address);
        while (currentPage.lt(lastAddress)) {
            pagesToRequest.push(currentPage);
            currentPage = currentPage.add(PAGE_SIZE);
        }

        return pagesToRequest;
    }

    function requestPages(pages, viewer, callback) {
        // Request all the pages, but only fire the callback once they've all loaded.
        var areAllPagesEligible = true;
        var loadedViews = new Array(pages.length);
        var remainingViews = pages.length;

        pages.forEach(function (page, i) {
            function pageLoaded(view) {
                loadedViews[i] = view;
                --remainingViews;
                if (remainingViews == 0 && areAllPagesEligible) {
                    callback(loadedViews);
                }
            }

            if (!loadPage(page, viewer, pageLoaded)) {
                areAllPagesEligible = false;
            }
        })
        return areAllPagesEligible;
    }

    function readArray(address, itemSize, isUnsigned, isFloat, count, callback) {
        address = new PointerMath.Pointer(address).value();

        var viewer = getArrayViewer(itemSize, isUnsigned, isFloat);
        var pagesToRequest = calculatePagesForArray(address, itemSize, count);
        var canUseCache = requestPages(pagesToRequest, viewer, function (views) {
            // All the pages that the array spans have been loaded in.
            var result = [];

            // For the first page, the first index is the offset of the address.  For subsequent pages it's zero.
            var indexInCurrentPage = getOffset(address, itemSize);
            var firstError = null;
            views.forEach(function (view) {
                if (firstError != null) {
                    return;
                } else if (view.error) {
                    firstError = view;
                    return;
                }

                // Gather elements either to the end of the page or the last element in the array.
                var remainingElements = count - result.length;
                var lastIndexInCurrentPage = Math.min(indexInCurrentPage + remainingElements, view.length);
                for (var i = indexInCurrentPage; i < lastIndexInCurrentPage; ++i) {
                    result.push(view[i]);
                }

                // Start from the beginning of the next page.
                indexInCurrentPage = 0;
            });

            if (firstError != null) {
                callback(firstError);
            } else {
                callback({ array: result });
            }
        });

        if (!canUseCache) {
            // One of the pages was not eligible for caching.  Fall back to the uncached request.
            JsDbg.ReadArray(address, itemSize, isUnsigned, isFloat, count, callback);
        }
    }

    // Any change in the state of the debugger will wipe the cache.
    JsDbg.RegisterOnBreakListener(clearCache);

    return {
        ReadPointer: readPointer,
        ReadNumber: readNumber,
        ReadArray: readArray
    };
})();