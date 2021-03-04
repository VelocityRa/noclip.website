
export function sprintf(fmt: string, ...args: any[]) {
    var i = -1;
    // @ts-ignore
    function callback(exp, p0, p1, p2, p3, p4) {
        if (exp == '%%') return '%';
        if (args[++i] === undefined) return undefined;
        exp = p2 ? parseInt(p2.substr(1)) : undefined;
        var base = p3 ? parseInt(p3.substr(1)) : undefined;
        var val;
        switch (p4) {
            case 's': val = args[i]; break;
            case 'c': val = args[i][0]; break;
            case 'f': val = parseFloat(args[i]).toFixed(exp); break;
            case 'p': val = parseFloat(args[i]).toPrecision(exp); break;
            case 'e': val = parseFloat(args[i]).toExponential(exp); break;
            case 'x': val = parseInt(args[i]).toString(base ? base : 16); break;
            case 'X': val = parseInt(args[i]).toString(base ? base : 16).toUpperCase(); break;
            case 'd': val = parseFloat(parseInt(args[i], base ? base : 10).toPrecision(exp)).toFixed(0); break;
        }
        val = typeof (val) == 'object' ? JSON.stringify(val) : val.toString(base);
        var sz = parseInt(p1); /* padding size */
        var ch = p1 && p1[0] == '0' ? '0' : ' '; /* isnull? */
        while (val.length < sz) val = p0 !== undefined ? val + ch : ch + val; /* isminus? */
        return val;
    }
    var regex = /%(-)?(0?[0-9]+)?([.][0-9]+)?([#][0-9]+)?([scfpexXd%])/g;
    return fmt.replace(regex, callback);
}
