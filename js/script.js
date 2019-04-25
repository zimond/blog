var cookie = {
    write : function (cname, cvalue, exdays) {
        var d = new Date();
        d.setTime(d.getTime() + (exdays*24*60*60*1000));
        var expires = "expires="+d.toUTCString();
        document.cookie = cname + "=" + cvalue + "; " + expires;
    },
    read : function (name) {
        if (document.cookie.indexOf(name) > -1) {
            return document.cookie.split(name)[1].split("; ")[0].substr(1)
        } else {
            return "";
        }
    },
    delete : function (cname) {
        var d = new Date();
        d.setTime(d.getTime() - 1000);
        var expires = "expires="+d.toUTCString();
        document.cookie = cname + "=; " + expires;
    }
};

// load theme
var current_theme = cookie.read("theme") === "dark" ? "dark" : "light";

function change_theme(theme) {
    var link = document.getElementById("theme");
    if (link) {
        link.parentNode.removeChild(link);
    }
    link = document.createElement("link");
    link.href = "/blog/css/" + theme + ".css";
    link.type = "text/css";
    link.rel = "stylesheet";
    link.id = "theme";
    document.getElementsByTagName("head")[0].appendChild(link);
    document.getElementById("theme-indicator").textContent = theme;
    current_theme = theme;
    cookie.write("theme", theme);
}

document.getElementById("theme-change-button").addEventListener("click", function() {
    change_theme(current_theme == "light" ? "dark" : "light");
});

change_theme(current_theme);