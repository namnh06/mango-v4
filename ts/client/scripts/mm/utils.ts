/** CUSTOM */
export function getUnixTs() {
    return new Date().getTime() / 1000;
};

export function percentageVolatility(a, b) {
    let percent;
    if (b !== 0) {
        if (a !== 0) {
            percent = (b - a) / a * 100;
        } else {
            percent = b * 100;
        }
    } else {
        percent = - a * 100;
    }
    return Math.abs(percent);
}