//! R-396: the category a manifest line is guessed into when the sheet has no category
//! column. Used by the Manifest analyzer's breakdown and by the split, on the desktop and
//! (byte for byte, like `manifest_split.rs`) on the server for the phone.
//!
//! It replaced a list of 60 bare substrings, first match wins, which read "Nike Dri-FIT
//! **Game** Classic Shorts" as Toys, "Shattered Backboard" sneakers as Accessories (the
//! "hat" in shattered), anything "adjustable" as Furniture, and put two thirds of a
//! Nike/Jordan load in Uncategorized because it knew no shorts, joggers, slides or
//! sneaker model names.
//!
//! How a title is read:
//! * **Whole words only.** "hat" never matches inside "shattered", "table" never inside
//!   "adjustable". A word may be plural ("shorts", "hoodies", "batteries").
//! * **The product noun wins.** Every phrase is either a product ("shorts", "air fryer")
//!   or context ("kitchen", "game", "camping"). Context only decides when no product word
//!   is there, so "Game Classic Shorts" is Clothing and "Monopoly Game" is Toys.
//! * **The first part of the title first.** A title is cut at commas, brackets, quotes,
//!   " - " and at "for", "with", "compatible", so "Backpack with Laptop Sleeve" is a
//!   backpack and a colourway in quotes cannot outvote the product in front of it.
//! * **Within that part, the last product word wins, then the longest phrase.** English
//!   puts the product last: "Shoe Rack" is a rack, "Laptop Bag" a bag, "Dog Bed" a pet
//!   bed (the two-word phrase beats "bed").
//! * **Size as a last resort.** No word at all, but a shoe size ("10.5", "4Y", "12C",
//!   "(GS)", "Men's 9") is Shoes; an apparel size at the end ("- XL", "Size M") is
//!   Clothing. Most sneaker lines name only a model and a size.
//!
//! No AI (Jack's rule, R-379): every decision is a word in the lists below.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Returned when nothing in the title says what it is.
pub(crate) const UNCATEGORIZED: &str = "Uncategorized";

/// `(category, product phrases, context phrases)`. Phrases are lowercase words in the
/// singular, separated by one space; "&" in a title reads as "and", hyphens and
/// apostrophes fall away ("T-Shirt" is "t shirt", "Men's" is "mens"). A phrase must not
/// appear twice anywhere in this table (a test checks).
const RULES: &[(&str, &[&str], &[&str])] = &[
    (
        "Shoes",
        &[
            "shoe", "sneaker", "boot", "bootie", "sandal", "slide", "flip flop", "flipflop",
            "clog", "slipper", "loafer", "moccasin", "mule", "heel", "stiletto", "espadrille", "runner",
            "aqua sock", "golf spikes", "golf shoe", "moc", "jungle moc",
            "cleat", "footwear", "high top", "hi top", "low top", "chukka", "ballet flat", "mary jane",
            "slip on", "wedge sandal", "water shoe", "running shoe", "croc", "flats",
            "crib shoe",
            "zapatos",
            "zapatillas",
            "cat footwear",
        ],
        &["trainer"],
    ),
    (
        "Clothing",
        &[
            "shirt", "tshirt", "tee", "teeshirt", "tank top", "crop top", "tube top", "halter top",
            "blouse", "camisole", "cami", "polo", "henley", "jersey", "sweater", "cardigan",
            "sweatshirt", "hoodie", "hoody", "pullover", "crewneck", "quarter zip", "half zip",
            "jacket", "coat", "parka", "anorak", "windbreaker", "vest", "gilet", "blazer", "suit",
            "tuxedo", "dress", "gown", "skirt", "skort", "romper", "jumpsuit", "overall", "overalls",
            "bodysuit", "onesie", "pajama", "pajamas", "pyjamas", "pj set", "sleepwear", "nightgown",
            "robe", "bathrobe", "loungewear", "lingerie", "bra", "bralette", "sports bra", "panty",
            "underwear", "boxer", "boxers", "boxer brief", "brief", "briefs", "undershirt", "thong",
            "trunks", "swim trunk", "swimwear", "swimsuit", "bikini", "rashguard", "rash guard",
            "legging", "leggings", "tights", "jogger", "joggers", "sweatpant", "sweatpants", "pant",
            "pants", "trouser", "trousers", "chino", "chinos", "jean", "jeans", "shorts", "short",
            "capri", "capris", "sock", "hosiery", "pantyhose", "stocking", "tracksuit", "track suit",
            "track jacket", "warm up", "kimono", "poncho", "rain jacket", "cover up", "coverall",
            "scrubs", "uniform", "costume", "outfit", "apparel", "clothing", "garment", "waist trainer",
            "tunic", "leotard", "unitard", "compression shirt", "base layer", "thermal underwear",
            "long sleeve top", "short sleeve top", "sleeveless top", "yoga top", "running top", "training top",
            "knit top", "mesh top", "ribbed top", "graphic top", "swim top", "bikini top", "workout top", "high neck top",
            "neck top", "crop", "pantalones", "pantalon", "manteau", "sudadera", "chaqueta", "vestido",
            "windrunner", "mid layer", "full zip", "1 2 zip", "1 4 zip", "medium support",
            "light support", "high support", "sweats", "tight", "puffer", "softshell", "rain shell",
            "clothes", "scrub set", "sleep and play set", "sundress", "snowsuit", "snow bib",
            "boardshorts", "board shorts", "singlet", "leg warmer", "boot sock", "stadium kit",
            "home kit", "away kit", "football kit", "soccer kit", "pnt", "trk pnt", "jsy", "shrt",
            "jggr", "tght", "hdy",
            "cat and jack",
            "support hose",
            "chemise",
            "camiseta",
            "overcoat",
            "peacoat",
        ],
        &["tank", "crew", "fleece", "denim", "dri fit", "drifit", "tie dye", "top", "knit", "cropped"],
    ),
    (
        "Accessories",
        &[
            "bag", "backpack", "daypack", "handbag", "purse", "tote", "crossbody", "clutch", "wallet",
            "card holder", "card case", "satchel", "duffel", "duffle", "fanny pack", "belt bag",
            "waist pack", "sling bag", "messenger bag", "gym sack", "drawstring bag", "luggage",
            "suitcase", "carry on", "garment bag", "hat", "cap", "beanie", "visor", "headband",
            "snapback", "bucket hat", "trucker hat", "balaclava", "belt", "suspender", "necktie",
            "bow tie", "neck tie", "scarf", "scarves", "glove", "mitten", "sunglass", "sunglasses",
            "eyewear", "watch", "wristwatch", "jewelry", "jewellery", "necklace", "bracelet",
            "earring", "ring", "pendant", "anklet", "brooch", "keychain", "key chain", "lanyard",
            "umbrella", "bandana", "hair clip", "claw clip", "scrunchie", "hair tie", "watch band",
            "wristband", "sweatband", "arm sleeve", "cufflink", "hair bow", "laces", "shoelace", "bkpk", "hip pack", "duff", "shoe horn",
            "shoe lace", "shoe laces", "sneaker laces", "waistpack", "aviator", "wayfarer", "pashmina",
            "earmuff", "earmuffs", "diaper bag backpack",
            "eye glasses",
            "eyeglasses",
            "blue light glasses",
            "sun glasses",
            "ratchet belt",
            "pocket square",
            "handkerchief",
            "laptop backpack",
            "back pack",
        ],
        &["drawstring"],
    ),
    (
        "Electronics",
        &[
            "tv", "television", "smart tv", "oled", "qled", "monitor", "laptop", "chromebook", "macbook",
            "computer", "ipad", "kindle", "e reader", "ereader", "phone", "smartphone",
            "iphone", "cell phone", "phone case", "iphone case", "ipad case", "tablet case",
            "screen protector", "charger", "charging cable", "charging dock", "charging station",
            "wireless charger", "usb cable", "hdmi cable", "lightning cable", "usb c cable", "adapter",
            "power bank", "portable charger", "battery", "batteries", "speaker", "soundbar",
            "sound bar", "subwoofer", "headphone", "earbud", "earphone", "headset", "airpods",
            "ear bud", "camera", "webcam", "camcorder", "drone", "projector", "router", "modem",
            "wifi extender", "mesh wifi", "hard drive", "ssd", "flash drive", "usb drive",
            "thumb drive", "memory card", "sd card", "micro sd", "keyboard", "mouse",             "printer", "scanner", "smart watch", "smartwatch",
            "fitness tracker", "smart plug", "smart speaker", "echo dot", "echo show", "fire tv",
            "fire stick", "firestick", "roku", "chromecast", "streaming stick", "remote control",
            "universal remote", "game console", "playstation", "ps5", "ps4", "xbox",
            "nintendo switch", "switch oled", "controller", "gamepad", "joystick", "video game",
            "vr headset", "graphics card", "gpu", "cpu", "motherboard", "ring light", "tripod",
            "gimbal", "selfie stick", "radio", "walkie talkie", "record player", "turntable",
            "cd player", "dvd player", "blu ray player", "amplifier", "microphone", "mic",
            "stylus", "apple pencil", "surge protector", "usb hub", "docking station", "calculator",
            "label printer", "doorbell", "video doorbell", "security camera", "hdmi", "ethernet cable",
            "cable", "apple watch", "galaxy watch", "tv mount", "tv wall mount", "tracker",
            "tracker tag", "airtag", "led strip", "strip light",
            "tablet!",
            "gaming pc",
            "desktop computer",
            "gaming console",
            "av receiver",
            "digital photo frame",
            "dvd drive",
            "cd drive",
            "optical drive",
            "cooling pad",
            "smart home hub",
            "hub",
            "digital notebook",
            "power station",
            "solar generator",
            "wifi outlet",
            "smart outlet",
            "smart bulb",
            "smart thermostat",
            "nest thermostat",
            "action cam",
            "gopro",
            "galaxy tab",
            "galaxy s21",
            "galaxy s22",
            "galaxy s23",
            "galaxy s24",
            "galaxy s25",
            "galaxy z",
            "galaxy a",
            "galaxy note",
            "galaxy buds",
            "moto g",
            "google pixel",
            "pixel 7",
            "pixel 8",
            "pixel 9",
            "spkr",
            "raspberry pi",
            "fire hd",
            "belt drive turntable",
            "desktop pc",
            "lap top",
            "t v",
            "mntr",
        ],
        &["wireless", "gaming", "smart", "digital", "usb", "electronic", "electronics", "gadget", "tws", "bluetooth", "console", "receiver", "display", "bt", "wifi"],
    ),
    (
        "Furniture",
        &[
            "sofa", "couch", "loveseat", "sectional", "recliner", "chair", "office chair",
            "gaming chair", "stool", "bar stool", "ottoman", "bench", "table", "coffee table",
            "end table", "side table", "console table", "dining table", "folding table", "desk",
            "standing desk", "tv stand", "nightstand", "night stand", "dresser", "chest of drawers",
            "armoire", "wardrobe", "bookcase", "bookshelf", "shelf", "shelves", "shelving",
            "shelving unit", "cabinet", "storage cabinet", "file cabinet", "filing cabinet",
            "futon", "bed", "bed frame", "headboard", "mattress", "bunk bed", "daybed", "bean bag",
            "credenza", "sideboard", "buffet", "vanity", "room divider", "coat rack", "hall tree",
            "furniture", "kitchen island", "bar cart", "accent chair", "rocking chair", "storage shelf",
            "medicine cabinet", "chair mat",
            "tv tray",
            "tv console",
        ],
        &[],
    ),
    (
        "Toys",
        &[
            "toy", "plush", "plushie", "stuffed animal", "teddy bear", "doll", "dollhouse",
            "baby doll", "action figure", "lego", "building set", "building block",
            "building blocks", "block set", "puzzle", "jigsaw puzzle", "board game", "card game",
            "party game", "family game", "playset", "play set", "play kitchen", "play tent",
            "play house", "playhouse", "rc car", "remote control car", "remote control truck",
            "ride on", "kick scooter", "kids scooter", "scooter", "nerf", "water gun", "squirt gun",
            "blaster", "slime", "play doh", "playdough", "kinetic sand", "stem kit", "science kit",
            "craft kit", "yo yo", "fidget", "fidget toy", "squishmallow", "squishmallows", "funko",
            "funko pop", "trading card", "pokemon card", "hot wheels", "barbie", "hatchimals",
            "lol surprise", "toy car", "train set", "toy train", "kite", "bubble machine",
            "bubble wand", "dress up", "magic kit", "rattle", "stacking toy", "shape sorter",
            "activity cube", "sensory toy", "pinata", "balloon", "water balloon", "marbles",
            "spinning top", "rubik", "rubiks cube", "toy figure", "figure set", "collectible figure",
            "monster truck", "dinosaur toy", "animal figure", "pop it", "slip n slide",
            "water slide", "sandbox", "sand toy", "beach toy", "bath toy", "pool toy", "hoverboard",
            "trampoline", "doll clothes", "tamagotchi", "magnetic tiles", "magna tiles",
            "playground slide", "stress ball", "ball pit", "nerf dart", "foam dart", "face paint",
            "tire swing", "xylophone", "bobblehead", "doll stroller",
            "wagon",
            "toy piano",
            "toy kitchen",
            "play food",
            "dollhouse furniture",
            "water table",
            "splash pad",
            "sidewalk chalk",
            "slot car",
            "race track",
            "racing track",
            "dice",
            "beyblade",
            "bey blade",
            "perler",
            "juguete",
            "trading cards",
            "toy tablet",
            "learning pad",
            "learning tablet",
            "toy football",
            "coloring set",
            "art case",
        ],
        &["game", "games", "kids play", "pretend play", "toddler toy"],
    ),
    (
        "Home & Kitchen",
        &[
            "cookware", "pots and pans", "pan", "frying pan", "skillet", "saucepan", "dutch oven",
            "wok", "stock pot", "pot", "bakeware", "baking sheet", "baking pan", "cake pan",
            "muffin pan", "cookie sheet", "mixing bowl", "bowl", "plate", "dinnerware",
            "dinner plate", "mug", "cup", "tumbler", "wine glass", "drinking glass", "glassware",
            "water bottle", "travel mug", "coffee maker", "espresso machine", "blender", "air fryer",
            "instant pot", "pressure cooker", "slow cooker", "crock pot", "rice cooker", "toaster",
            "toaster oven", "microwave", "kettle", "tea kettle", "electric kettle", "mixer",
            "stand mixer", "hand mixer", "food processor", "juicer", "waffle maker", "waffle iron",
            "griddle", "ice maker", "dehydrator", "can opener", "knife", "knives", "knife set",
            "cutting board", "utensil", "spatula", "tong", "tongs", "whisk", "ladle",
            "measuring cup", "measuring spoon", "colander", "strainer", "food storage",
            "storage container", "food container", "lunch box", "lunch bag", "water filter",
            "coffee grinder", "wine opener", "corkscrew", "spice rack", "paper towel", "dish rack",
            "dish drying rack", "dish soap", "dishwasher", "dishwasher tablet", "dishwasher pod",
            "refrigerator", "fridge", "mini fridge", "freezer", "vacuum", "vacuum cleaner",
            "robot vacuum", "stick vacuum", "vacuum sealer", "mop", "steam mop", "broom",
            "dustpan", "carpet cleaner", "air purifier", "humidifier", "dehumidifier", "fan",
            "tower fan", "box fan", "space heater", "heater", "air conditioner", "portable ac",
            "window ac", "iron", "steam iron", "ironing board", "garment steamer", "steamer",
            "laundry basket", "hamper", "hanger", "closet organizer", "storage bin", "bin",
            "basket", "storage basket", "trash can", "garbage can", "trash bag", "garbage bag",
            "wastebasket", "waste basket", "towel", "bath towel", "hand towel", "beach towel",
            "kitchen towel", "dish towel", "washcloth", "shower curtain", "bath mat", "bath rug",
            "rug", "area rug", "runner rug", "doormat", "door mat", "curtain", "drape", "blind",
            "window shade", "valance", "pillow", "throw pillow", "bed pillow", "pillowcase",
            "pillow case", "pillow cover", "sham", "blanket", "throw blanket", "weighted blanket",
            "comforter", "duvet", "duvet cover", "quilt", "sheet", "sheet set", "bed sheet",
            "fitted sheet", "mattress pad", "mattress topper", "mattress protector", "bedding",
            "bed skirt", "candle", "candle holder", "tea light", "vase", "picture frame",
            "photo frame", "wall art", "canvas art", "poster", "wall decor", "artificial plant",
            "artificial flower", "fake plant", "wreath", "christmas tree", "ornament", "garland",
            "string light", "fairy light", "lamp", "desk lamp", "floor lamp", "table lamp",
            "lampshade", "night light", "mirror", "clock", "alarm clock", "wall clock",
            "photo album", "shoe rack", "shoe organizer", "rack", "hook", "wall hook",
            "toilet paper", "tissue",
            "laundry detergent", "detergent", "fabric softener", "dryer sheet", "bleach",
            "cleaner", "all purpose cleaner", "glass cleaner", "disinfecting wipe", "wipe",
            "sponge", "scrub brush", "air freshener", "aluminum foil", "plastic wrap",
            "parchment paper", "paper plate", "napkin", "gift wrap", "wrapping paper", "gift bag",
            "tissue paper", "tablecloth", "table cloth", "table runner", "placemat", "coaster",
            "soap dispenser", "toothbrush holder", "shower caddy", "oven mitt", "pot holder",
            "potholder", "apron", "step stool", "sewing machine", "diffuser", "oil diffuser", "hat box",
            "cleaning kit", "shoe cleaner", "sneaker cleaner", "detergent tablet", "gift tin",
            "rug runner", "hallway runner",
            "washing machine", "washer dryer", "dryer", "dryer ball", "spray bottle", "boot tray",
            "shelf liner", "bed in a bag", "bookends", "snow globe", "milk crate", "storage crate",
            "wine cooler", "water cooler", "paper bag", "side mirror", "meat grinder",
            "electric grill", "indoor grill", "contact grill", "panini grill",
            "coffee mug", "thermos", "food scale", "kitchen scale", "bathroom scale", "trivet",
            "salt and pepper", "grinder", "cooler bag", "ice pack", "jar", "mason jar", "canister",
            "pitcher", "carafe", "teapot", "french press", "cocktail shaker", "ice cube tray",
            "silverware", "flatware", "cutlery", "chopsticks", "storage bag", "ziploc bag",
            "sandwich bag", "freezer bag", "vacuum storage bag", "space saver bag", "hot dog",
            "popcorn maker", "popcorn machine", "bread maker", "sous vide",
            "cake stand", "cupcake liner", "rolling pin", "piping bag", "cookie cutter",
            "home decor", "decorative", "decoration", "kitchen gadget", "bedspread", "coverlet",
            "comforter set", "slipcover", "sofa cover", "couch cover", "chair cover",
            "seat cushion", "chair cushion", "floor cushion", "sofa cushion", "couch cushion", "chair pad", "body pillow", "memory foam pillow",
            "sleep mask", "laundry bag", "lint roller", "clothes hanger", "drying rack",
            "trash bin", "recycling bin", "paper towel holder", "dish brush", "bottle brush",
            "kitchen sink caddy", "sink caddy", "utensil holder", "knife block", "bread box",
            "cake mold", "silicone mold", "ice mold", "egg cooker", "hot plate", "range hood",
            "stove", "oven", "cooktop", "burner", "mosquito net",
            "bed bug",
            "bed bug spray",
            "pasta roller",
            "pasta maker",
            "oil sprayer",
            "oil mister",
            "carpet shampoo",
            "slicer",
            "chopper",
            "peeler",
            "grater",
            "mandoline",
            "garlic press",
            "salad spinner",
            "ice cream maker",
            "spoon",
            "turner",
            "clothes folder",
            "folding board",
            "fabric shaver",
            "sweater shaver",
            "lint shaver",
            "defuzzer",
            "canvas print",
            "art print",
            "framed print",
            "pizza stone",
            "shoe storage",
            "storage box",
            "toilet brush",
            "plugin",
            "plug in",
            "scented oil",
            "wax melt",
            "washer",
            "front load washer",
            "top load washer",
            "quencher",
            "sweeper",
            "swiffer",
            "electric range",
            "gas range",
            "tree skirt",
            "clothespin",
            "clothes pin",
            "sock organizer",
            "food bag",
            "silicone bag",
            "book ends",
            "air fryer liner",
            "water softener",
            "housewares",
            "ollas",
            "christmas lights",
            "baguette pan",
            "bread pan",
            "loaf pan",
            "coffee mkr",
        ],
        &["kitchen", "bath", "bathroom", "bedroom", "home", "household", "decor", "dining", "glass", "cleaning", "laundry"],
    ),
    (
        "Tools & Hardware",
        &[
            "tool", "tool set", "tool kit", "toolkit", "tool box", "toolbox", "tool bag",
            "tool belt", "multi tool", "multitool", "drill", "power drill", "cordless drill",
            "hammer drill", "impact driver", "impact wrench", "wrench", "torque wrench", "hammer",
            "screwdriver", "screwdriver set", "plier", "pliers", "saw", "circular saw", "table saw",
            "miter saw", "reciprocating saw", "jigsaw", "hacksaw", "sander", "orbital sander",
            "angle grinder", "nail gun", "staple gun", "glue gun", "heat gun", "caulk gun",
            "air compressor", "compressor", "generator", "shop vac", "wet dry vac", "laser level",
            "tape measure", "measuring tape", "stud finder", "utility knife", "box cutter",
            "work light", "flashlight", "extension cord", "power strip", "outlet", "light switch",
            "dimmer", "light bulb", "led bulb", "bulb", "ceiling light", "light fixture",
            "chandelier", "pendant light", "sconce", "wall sconce", "track light", "floodlight",
            "flood light", "faucet", "kitchen faucet", "sink", "toilet", "toilet seat",
            "garbage disposal", "water heater", "thermostat", "smart lock", "door lock",
            "padlock", "lock", "deadbolt", "door handle", "doorknob", "door knob", "knob",
            "cabinet knob", "drawer pull", "hinge", "screw", "screws", "nail", "nails", "bolt",
            "lug nut", "wing nut", "hex nut", "zip tie", "cable tie", "duct tape", "tape", "glue",
            "wood glue", "super glue", "sealant", "caulk", "paint", "spray paint", "paint brush",
            "paintbrush", "paint roller", "wood stain", "sandpaper", "work glove", "safety glasses",
            "safety glass", "respirator", "ear protection", "ear muff", "hard hat", "workbench",
            "sawhorse", "ladder", "step ladder", "pegboard", "tarp", "chain", "bungee cord", "rope ladder",
            "multimeter", "voltage tester", "soldering iron", "torpedo level", "spirit level",
            "bubble level", "box level", "welder", "welding", "drill bit",
            "saw blade", "router bit", "socket set", "socket", "ratchet", "air tool", "clamp",
            "vise", "chisel", "file set", "crowbar", "pry bar", "wire stripper", "crimper",
            "electrical tape", "wire", "conduit", "junction box", "smoke detector",
            "carbon monoxide detector", "smoke alarm", "doorbell chime", "mailbox", "house number",
            "shower valve", "pipe", "pvc", "fitting", "valve", "plumbing", "drain", "plunger",
            "toilet plunger", "drain snake", "hose clamp", "weatherstrip", "weather stripping",
            "door sweep", "garage storage", "wall anchor", "magnetic strip", "paint primer", "wall primer",
            "tool chest", "tool cabinet", "rolling tool box", "hardware", "fastener", "rivet",
            "grout", "tile", "flooring", "vinyl flooring", "laminate flooring", "baseboard",
            "trim", "molding", "drywall", "insulation", "lumber", "plywood",
            "shower head",
            "showerhead",
            "garage door opener",
            "hand truck",
            "dolly",
            "wall scanner",
            "cabinet pull",
            "rolling cabinet",
            "shelf bracket",
            "work bench",
            "pallet jack",
            "pvc primer",
            "pipe cement",
            "pvc cement",
            "cement primer",
            "ceiling fan",
            "towel bar",
            "outlet cover plate",
            "wall plate",
            "cover plate",
            "air hose",
            "compressor hose",
            "electrical",
            "lighting",
            "lock washer",
            "flat washer",
                        
        ],
        &["cordless", "power tool", "rope"],
    ),
    (
        "Health & Beauty",
        &[
            "beauty", "cosmetic", "cosmetics", "skincare", "skin care", "makeup", "make up",
            "lipstick", "lip gloss", "lip balm", "lip liner", "lip stain", "chapstick", "mascara", "nail lamp", "nail drill", "fake nails",
            "false nails", "acrylic nails", "gel nails", "makeup primer", "eye primer",
            "makeup highlighter", "face highlighter", "highlighter palette", "liquid highlighter",
            "highlighter stick", "nitrile glove", "latex glove", "disposable glove",
            "kinesiology tape", "menstrual cup", "tea tree oil",
            "eyeliner", "eyeshadow", "eye shadow", "eyeshadow palette", "foundation", "concealer",
            "blush", "bronzer", "setting spray", "setting powder", "face powder",
            "primer", "face primer", "makeup brush", "makeup sponge", "beauty blender",
            "nail polish", "nail kit", "nail clipper", "nail file", "nail art", "press on nails",
            "gel polish", "false lashes", "false eyelashes", "lashes", "lash serum", "brow pencil",
            "eyebrow pencil", "perfume", "cologne", "fragrance", "eau de parfum", "eau de toilette",
            "body spray", "body mist", "deodorant", "antiperspirant", "shampoo", "conditioner",
            "dry shampoo", "hair dryer", "blow dryer", "flat iron", "curling iron", "curling wand",
            "hair straightener", "straightener", "hot brush", "hair brush", "hairbrush", "comb",
            "hair clipper", "clipper", "clippers", "beard trimmer", "trimmer", "razor",
            "razor blade", "shaver", "electric shaver", "epilator", "shaving cream", "body wash",
            "bar soap", "soap", "hand soap", "lotion", "body lotion", "moisturizer", "face cream",
            "eye cream", "face wash", "facial cleanser", "cleanser", "serum", "toner pad",
            "face mask", "sheet mask", "sunscreen", "sun screen", "spf", "hand sanitizer",
            "sanitizer", "toothpaste", "toothbrush", "electric toothbrush", "floss", "water flosser",
            "mouthwash", "teeth whitening", "whitening strips", "oral care", "vitamin", "vitamins",
            "multivitamin", "gummies", "supplement", "chewable tablet", "probiotic", "protein powder", "whey protein",
            "fish oil", "melatonin", "collagen", "pain relief", "ibuprofen", "acetaminophen",
            "allergy relief", "cold medicine", "first aid", "first aid kit", "bandage", "band aid",
            "thermometer", "blood pressure monitor", "pulse oximeter", "heating pad",
            "massage gun", "massager", "reading glasses", "contact lens", "hearing aid",
            "pregnancy test", "tampon", "sanitary pad", "maxi pad", "incontinence",
            "adult diaper", "cotton swab", "q tip", "cotton ball", "hair color", "hair dye",
            "hair spray", "hairspray", "hair gel", "hair oil", "hair mask", "leave in",
            "wig", "hair extension", "bath bomb", "bath salt", "essential oil", "bobby pin",
            "tweezers", "loofah", "exfoliator", "body scrub", "face scrub", "acne", "retinol",
            "hyaluronic", "vitamin c serum", "self tanner", "tanning", "shaving", "aftershave",
            "beard oil", "cuticle", "foot file", "pumice", "knee brace",
            "back brace", "wrist brace", "brace", "support belt", "cpap", "nebulizer",
            "pill organizer", "cane", "walker", "wheelchair", "shower chair", "grab bar",
            "personal care", "medicine", "otc",
            "epsom salt",
            "bath soak",
            "top coat",
            "base coat",
            "nail lacquer",
            "glucose monitor",
            "test strip",
            "vanity mirror",
            "makeup mirror",
            "cosmetic mirror",
            "blender sponge",
            "blotting paper",
            "blot paper",
            "oil absorbing sheet",
            "mask sheet",
            "makeup remover",
            "make up remover",
            "thickening spray",
            "detangling brush",
            "antifungal",
            "whitestrips",
            "whitening strip",
            "micellar water",
            "cleansing water",
            "lice",
            "wound care",
            "wound dressing",
            
        ],
        &["hair", "skin", "face", "lip", "eye", "health", "medical", "cream"],
    ),
    (
        "Books & Media",
        &[
            "book", "novel", "paperback", "hardcover", "board book", "textbook", "cookbook",
            "coloring book", "activity book", "sticker book", "comic book", "comic", "graphic novel",
            "magazine", "dvd", "blu ray", "bluray", "cd", "vinyl record", "record album", "lp",
            "audiobook", "workbook", "bible",
            "recipe",
            "trilogy",
            "boxed set",
            "box set",
            "dictionary",
            "movies",
            "music",
        ],
        &["vinyl", "manga"],
    ),
    (
        "Sports & Outdoors",
        &[
            "basketball", "football", "soccer ball", "baseball", "softball", "volleyball",
            "tennis racket", "racket", "racquet", "tennis ball", "golf ball", "golf club",
            "golf bag", "golf glove", "pickleball", "pickleball paddle", "paddle",
            "yoga mat", "exercise mat", "dumbbell", "kettlebell", "barbell", "weight plate",
            "weight bench", "resistance band", "exercise bike", "stationary bike", "treadmill",
            "elliptical", "rowing machine", "jump rope", "pull up bar", "foam roller",
            "punching bag", "boxing glove", "boxing gloves", "tent", "sleeping bag", "sleeping pad",
            "air mattress", "camping chair", "camp chair", "cooler", "lantern",
            "headlamp", "trekking pole", "hiking pole", "fishing rod", "fishing pole",
            "fishing reel", "tackle box", "fishing lure", "lure", "life jacket", "life vest",
            "kayak", "paddleboard", "paddle board", "surfboard", "skateboard", "longboard",
            "roller skate", "inline skate", "ice skate", "skates", "helmet", "bike helmet",
            "bike", "bicycle", "bike lock", "bike light", "electric scooter", "e scooter",
            "ebike", "e bike", "basketball hoop", "soccer goal", "ping pong", "table tennis", "ping pong table", "pool table", "bike rack", "bike trainer",
            "pool cue", "billiard", "dart board", "dartboard", "dart", "cornhole", "bowling ball",
            "ski", "skis", "snowboard", "ski goggles", "swim goggles", "goggles", "binoculars",
            "rifle scope", "scope", "trail camera", "archery", "compound bow", "recurve bow", "crossbow",
            "golf tee", "flotation vest", "float vest", "buoyancy aid",
            "pocket knife", "hydration pack", "water bladder", "sports bottle", "shin guard",
            "mouth guard", "mouthguard", "knee pad", "elbow pad", "baseball bat", "bat",
            "baseball glove", "catchers mitt", "hockey stick", "lacrosse stick", "puck",
            "sled", "snowshoe", "climbing", "carabiner", "camping stove", "camp stove",
            "water filter bottle", "compass", "gun case", "holster", "ammo box", "gun cleaning kit",
            "decoy", "tree stand", "fishing line", "gym bag", "sports bag", "agility ladder",
            "ab roller", "exercise ball", "stability ball", "medicine ball", "slam ball",
            "weight vest", "ankle weight", "wrist weight", "grip strengthener", "yoga block",
            "yoga strap", "pilates", "fitness equipment", "home gym", "squat rack", "power rack",
            "bench press", "workout bench", "rebounder", "pogo stick", "swim fins", "snorkel",
            "wetsuit", "wet suit", "boogie board", "body board", "bodyboard", "sports equipment",
            "ball", "basketball net", "soccer net", "volleyball net", "fishing net", "golf net",
            "whistle", "stopwatch", "scoreboard", "fishing hook", "fish hook", "air bed",
            "boxing bag",
            "chalk bag",
            "swim cap",
            "weightlifting belt",
            "lifting belt",
            "hydration vest",
            "running vest",
            "bike phone holder",
            "handlebar mount",
            "water purification",
            "camping pillow",
            "hunting blind",
            "ground blind",
            "sports water bottle",
            "horseshoe",
            "horseshoes",
            "badminton",
            "gymnastics",
            "shaker bottle",
            "sporting goods",
            "chin up bar",
        ],
        &["camping", "hiking", "fitness", "exercise", "workout", "gym", "hunting", "fishing", "sports", "sport", "athletic", "training", "yoga", "tennis", "soccer", "swim", "running", "golf"],
    ),
    (
        "Baby",
        &[
            "diaper", "diapers", "diaper bag", "diaper pail", "baby wipe", "baby wipes",
            "stroller", "jogging stroller", "car seat", "infant car seat", "booster seat", "crib",
            "crib mattress", "bassinet", "pack n play", "playard", "play yard", "playpen",
            "high chair", "highchair", "baby monitor", "video baby monitor", "baby bottle",
            "bottle warmer", "bottle sterilizer", "breast pump", "nursing pillow", "pacifier",
            "teether", "teething", "baby carrier", "baby wrap", "baby gate", "safety gate",
            "bouncer", "baby bouncer", "baby swing", "baby walker", "activity center",
            "changing pad", "changing table", "swaddle", "sleep sack", "wearable blanket",
            "burp cloth", "bib", "sippy cup", "baby food", "infant formula", "baby formula",
            "potty", "potty training", "potty seat", "potty trainer", "baby bath", "baby tub",
            "baby shampoo", "baby lotion", "nasal aspirator", "baby nail clipper", "baby proofing",
            "outlet cover", "cabinet lock", "play mat", "playmat", "tummy time", "baby gym",
            "crib sheet", "baby blanket", "receiving blanket", "muslin", "bumbo",
            "diaper cream", "rash cream", "baby camera",
            "potty training pants",
            "easy ups",
            "pull ups",
            "baby monitor camera",
            "bed rail",
            "baby towel",
            "baby bath towel",
            "hooded towel",
            "teether toy",
            "nursing cover",
            "breastfeeding",
            "stroller organizer",
            "stroller organizer bag",
            "nap mat",
        ],
        &["baby", "infant", "newborn", "nursery"],
    ),
    (
        "Pet Supplies",
        &[
            "dog food", "cat food", "puppy food", "kitten food", "pet food", "dog treat",
            "cat treat", "pet treat", "dog chew", "chew toy", "cat litter", "litter", "litter box",
            "dog leash", "leash", "dog collar", "cat collar", "pet collar", "dog harness",
            "pet bed", "dog bed", "cat bed", "cat tree", "cat tower", "cat condo", "scratching post",
            "cat scratcher", "scratcher", "dog crate", "pet crate", "crate", "kennel", "dog kennel",
            "pet carrier", "cat carrier", "dog carrier", "dog toy", "cat toy", "pet toy",
            "squeaky toy", "dog bowl", "cat bowl", "pet bowl", "pet feeder", "automatic feeder",
            "pet fountain", "cat water fountain", "dog water fountain", "pet water fountain", "aquarium", "fish tank", "fish food", "bird cage",
            "hamster", "guinea pig", "pet gate", "dog gate", "dog shampoo", "pet shampoo",
            "flea", "flea and tick", "flea collar", "puppy pad", "pee pad", "potty pad",
            "poop bag", "dog poop bag", "dog sweater", "dog coat", "dog jacket",
            "dog costume", "cat costume", "pet costume", "dog raincoat", "dog boot", "dog shoe",
            "dog bandana", "dog hoodie", "dog shirt", "dog tag", "pet tag", "catnip", "cat grass",
            "pet brush", "dog brush", "deshedding", "pet grooming", "dog clipper", "pet hair",
            "dog door", "pet door", "dog ramp", "pet stairs", "pet steps", "dog stroller",
            "pet", "pets",
            "bully stick",
            "ball launcher",
            "reptile",
            "dog biscuit",
            "milk bone",
            "dog sock",
        ],
        &["dog", "dogs", "cat", "cats", "puppy", "puppies", "kitten", "kittens", "canine", "feline"],
    ),
    (
        "Automotive",
        &[
            "seat cover", "car seat cover", "floor mat", "car floor mat", "floor liner",
            "steering wheel cover", "car mount", "car phone mount", "car phone holder", "phone mount",
            "dash cam", "dashcam", "jump starter", "jumper cable", "tire inflator", "tire",
            "tire pressure gauge", "wiper blade", "windshield wiper", "windshield", "motor oil",
            "oil filter", "cabin air filter", "engine air filter", "brake pad", "brake rotor",
            "spark plug", "headlight", "tail light", "taillight", "car wax", "car wash", "car cover",
            "car vacuum", "car battery", "trailer hitch", "hitch", "tow strap", "tow rope",
            "roof rack", "cargo carrier", "license plate", "license plate frame", "car organizer",
            "trunk organizer", "sun shade", "windshield sun shade", "car air freshener", "obd2",
            "backup camera", "car stereo", "car speaker", "car charger", "car seat organizer",
            "seat gap filler", "car cleaning", "detailing", "car detailing",
            "tire shine", "car polish", "ratchet strap", "tie down", "truck bed", "tonneau",
            "mud flap", "running board", "car jack", "jack stand", "oil drain pan",
            "motorcycle helmet", "motorcycle", "trailer", "rv", "seat belt", "rearview mirror",
            "serpentine belt",
            "battery maintainer",
            "battery booster",
            "hitch receiver",
            "ball mount",
            "bed extender",
            "tailgate",
            "car wash soap",
            "cargo rack",
            "protectant",
            "car vacuum cleaner",
            "fuel injector",
            "fuel system",
            "wheel cleaner",
            "bumper sticker",
            "cargo net",
            "headlight bulb",
            "lug nut wrench",
            "lug wrench",
            "antifreeze",
            "coolant",
            "transmission fluid",
            "wiper fluid",
            "washer fluid",
            "brake fluid",
            "cargo cover",
            "light bar",
            "wiring harness",
            "cargo liner",
            "5w 20",
            "5w 30",
            "10w 30",
            "0w 20",
            "synthetic oil",
            "car wash sponge",
        ],
        &["car", "auto", "automotive", "vehicle", "truck", "suv", "jeep"],
    ),
    (
        "Office & School",
        &[
            "office supplies", "school supplies", "pen", "ballpoint", "gel pen", "pencil",
            "mechanical pencil", "colored pencil", "marker", "dry erase marker", "permanent marker",
            "highlighter", "highlighter pen", "paint by number", "crayon", "crayons", "notebook", "spiral notebook", "composition book",
            "journal", "planner", "agenda", "sticky note", "post it", "binder", "folder",
            "file folder", "paper clip", "binder clip", "stapler", "staples", "printer paper",
            "copy paper", "index card", "envelope", "label", "label maker", "packing tape",
            "scotch tape", "washi tape", "masking tape", "scissors", "ruler", "protractor",
            "whiteboard", "dry erase board", "bulletin board", "cork board", "desk organizer",
            "file organizer", "desk pad", "pencil case", "pencil pouch", "pencil sharpener",
            "eraser", "glue stick", "construction paper", "cardstock", "art supplies",
            "sketchbook", "sketch pad", "easel", "watercolor", "acrylic paint",
            "paint set", "shredder", "paper shredder", "laminator", "hole punch", "tape dispenser",
            "clipboard", "calendar", "wall calendar", "desk calendar", "letter tray", "rubber band",
            "push pin", "thumbtack", "correction tape", "white out", "chalk", "chalkboard",
            "yarn", "knitting", "crochet", "sewing kit", "felt", "craft", "crafts",
            "scrapbook", "stickers", "sticker", "stencil", "stamp", "ink pad", "calligraphy",
            "fountain pen", "notepad", "memo pad", "graph paper", "loose leaf",
            "book cover", "book bag", "school bag", "graphing calculator", "globe", "flash card",
            "flashcard", "teacher supplies", "classroom",
            "ink cartridge",
            "toner",
            "toner cartridge",
            "mouse pad",
            "address book",
            "monitor riser",
            "monitor stand",
            "monitor arm",
            "cable management",
            "desk mat",
            "paper cutter",
            "paper trimmer",
            "poster board",
            "school glue",
            "magic tape",
            "desktop organizer",
            "mail sorter",
            "paper cutter trimmer",
        ],
        &["office", "school", "stationery", "paper", "fabric", "canvas"],
    ),
    (
        "Patio & Garden",
        &[
            "garden hose", "hose", "hose nozzle", "hose reel", "sprinkler", "lawn mower", "mower",
            "leaf blower", "blower", "snow blower", "hedge trimmer", "string trimmer",
            "weed eater", "weed wacker", "pressure washer", "power washer", "chainsaw", "planter",
            "flower pot", "plant pot", "raised garden bed", "garden bed", "potting soil", "soil",
            "fertilizer", "mulch", "seed", "seeds", "grass seed", "plant", "live plant", "bird bath",
            "beach chair", "lawn chair", "picnic table", "garden fountain", "outdoor fountain",
            "fountain pump", "charcoal briquette", "lump charcoal",
            "birdbath", "bird house", "birdhouse", "solar light", "solar lights", "pathway light",
            "landscape light", "patio umbrella", "patio furniture", "patio chair", "patio set",
            "patio table", "outdoor furniture", "outdoor rug", "outdoor cushion", "adirondack chair",
            "porch swing", "fire pit", "firepit", "grill", "grill cover", "grill brush",
            "grill tool", "bbq", "barbecue", "smoker", "pellet grill", "wood pellet",
            "garden tool", "shovel", "rake", "hoe", "trowel", "wheelbarrow", "pruning shear",
            "pruner", "lopper", "garden glove", "watering can", "pool float", "pool noodle",
            "inflatable pool", "above ground pool", "kiddie pool", "pool cover", "pool filter",
            "pool cleaner", "pool", "hot tub", "gazebo", "canopy", "pop up canopy", "shade sail",
            "artificial grass", "turf", "fence", "garden fence", "garden decor", "garden statue",
            "gnome", "garden gnome", "wind chime", "bug zapper", "mosquito repellent",
            "weed killer", "insect killer", "pest control", "mouse trap", "rat trap",
            "animal trap", "deer repellent", "greenhouse", "trellis", "compost", "composter",
            "rain barrel", "patio heater", "outdoor heater", "chiminea",
            "deck box", "outdoor storage", "shed", "outdoor light", "string trimmer line",
            "snow shovel", "ice melt",
            "bird feeder",
            "bird seed",
            "birdseed",
            "hammock",
            "charcoal briquet",
            "firewood",
            "fire starter",
            "compost bin",
            "compost tumbler",
            "solar string light",
            "fire pit bowl",
            "garden scissors",
            "weed barrier",
            "landscape fabric",
            "flower bulb",
            "tulip bulb",
            "garden tool kit",
            "garden tool set",
            "potting mix",
            "pond pump",
            "pond",
            "garden kneeler",
            "kneeler",
            "propane",
        ],
        &["outdoor", "backyard", "porch", "deck", "solar", "lawn", "yard", "garden", "patio"],
    ),
    (
        "Grocery",
        &[
            "snack", "snacks", "chips", "candy", "gum", "chewing gum", "chocolate bar",
            "chocolate chip", "chocolate candy", "dark chocolate", "milk chocolate", "hot chocolate",
            "chia seed", "flax seed", "sunflower seeds", "pumpkin seeds", "gummy bear", "gummy candy",
            "cereal", "ground coffee", "coffee bean", "whole bean", "k cup", "k cups",
            "coffee pod", "tea", "tea bag", "green tea", "juice", "soda", "sparkling water",
            "bottled water", "energy drink", "sports drink", "drink mix", "beverage", "sauce",
            "hot sauce", "ketchup", "mustard", "mayo", "mayonnaise", "salad dressing",
            "olive oil", "cooking oil", "vegetable oil", "spice", "spices", "seasoning", "salt",
            "sugar", "flour", "pasta", "noodle", "ramen", "rice", "beans", "canned", "soup", "cookie",
            "cracker", "nut", "nuts", "almond", "almonds", "peanut butter", "jerky", "popcorn",
            "protein bar", "granola", "granola bar", "oats", "syrup",
            "maple syrup", "jam", "jelly", "creamer", "coffee creamer", "baking mix", "cake mix",
            "grocery", "pantry", "trail mix", "dried fruit", "fruit snack", "milk", "shelf stable",
            "pretzel", "pretzels", "crisps", "biscuits", "baking soda", "vinegar", "broth",
            "tuna", "canned tuna", "pickles", "salsa", "dip", "hummus", "bbq sauce",
            "bagel",
            "baguette",
            "bread",
            "cheese",
            "mac and cheese",
            "spring water",
            "pop tarts",
            "ranch dressing",
            "fruit bar",
            "vegetable",
            "vegetables",
            "frozen vegetables",
            "fruit cup",
            "mixed fruit",
            "mixed nuts",
            "whole bean coffee",
            "coffee beans",
            "k cup pods",
        ],
        &["organic", "gluten free", "keto", "vegan", "chocolate", "honey", "oatmeal", "food", "coffee"],
    ),
    (
        "General Merchandise",
        &["general merchandise", "mystery box", "customer returns", "shelf pull", "shelf pulls", "grab bag"],
        &["pallet", "lot", "assorted", "mixed", "misc", "miscellaneous", "variety", "overstock", "returns", "bundle", "assortment", "softlines", "hardlines"],
    ),
];

/// Sneaker models. Most sneaker lines name only the model, a colourway and a size, so a
/// model reads as Shoes. A word after the model can still say otherwise when it is a
/// piece of clothing or an accessory ("Air Jordan Hoodie", "Air Force 1 Keychain"), but
/// not when it is part of the model's name or colour ("Air Max **Bolt**", "Air Jordan 1
/// Low G **Golf**", "Jordan 6 **Rings**").
const SHOE_MODELS: &[&str] = &[
    "air jordan", "jordan 1", "jordan 3", "jordan 4", "jordan 5", "jordan 6", "jordan 11", "jordan 12",
    "jordan 13", "6 rings", "aj1", "aj4", "aj11", "retro high og", "retro low og", "air force 1", "force 1",
    "af1", "air max", "airmax", "vapormax", "air peg", "dunk", "sb dunk", "blazer mid", "blazer low", "cortez",
    "pegasus", "vomero", "invincible run", "infinity run", "zoomx", "zoom fly", "zoom bella", "metcon",
    "air zoom", "zoom air", "court vision", "court legacy", "court borough", "court royale", "revolution 6",
    "revolution 7", "revolution 8", "downshifter", "winflo", "air monarch", "huarache", "air presto",
    "foamposite", "lebron", "kyrie", "giannis immortality", "why not zero", "air rift", "p 6000", "v2k",
    "killshot", "flight club", "shox", "waffle debut", "waffle one", "reactx", "rejuven8", "star runner",
    "run swift", "interact run", "son of mars", "stay loyal", "tiempo", "phantom gx", "mercurial",
    "total 90", "benassi", "ebernon", "gp challenge", "reax 8", "quest 5", "quest 6", "legend essential",
    "tatum 1", "tatum 2", "tatum 3", "tatum 4", "luka 1", "luka 2", "luka 3", "luka 4", "luka 5", "trunner",
    "spizike", "air more uptempo", "uptempo", "max aura", "flex runner", "flex experience",
    "renew run", "structure 25", "journey run", "motiva", "calm slide", "victori one", "offcourt",
    "nike burrow", "air max plus", "cosmic unity", "g t cut", "gt cut", "book 1", "kd", "kobe 6", "kobe 8", "kobe 9", "kobe protro", "ja 1",
    "ja 2", "sabrina", "atwo", "jumpman pro", "nike structure", "response runner", "hovr",
    "speedcat", "puma palermo", "puma suede", "suede classic", "ultrarange", "neumel", "scuffette", "arahi", "kawana", "cloudmonster",
    "project rock", "moab", "disruptor", "1460", "shadow 6000", "question mid", "new balance 574", "new balance 990",
    "new balance 550", "new balance 9060", "new balance 2002r", "new balance 530", "new balance 327", "990v5", "990v6",
    "nb 574", "nb 990", "m574", "rs x", "suede xl", "brooks ghost", "ghost 15", "ghost 16", "saucony endorphin",
    "endorphin speed", "endorphin pro", "retro 4", "jordan retro", "renew ride", "tanjun", "in season tr", "air trainer",
    "vaporfly", "free run", "curry 10", "curry 11", "curry 12", "precision 7", "team hustle", "zoom freak",
    "sld", "flex sld", "samba", "gazelle",
    "stan smith", "ultraboost", "ultra boost", "nmd", "forum low", "forum high", "campus 00s", "yeezy",
    "adidas superstar", "superstar ii", "superstar og",
    "adilette", "cloudfoam", "grand court", "duramo", "adizero", "handball spezial", "ozweego",
    "runfalcon", "lite racer", "chuck taylor", "chuck 70", "all star", "run star", "old skool",
    "sk8 hi", "classic clog", "crocband", "echo clog", "fresh foam", "fuelcell", "gel kayano",
    "gel nimbus", "gel 1130", "hoka clifton", "hoka bondi", "speedgoat", "tasman", "tazz", "club c",
    "go walk", "arch fit",
];

/// Products that decide the category wherever they sit in the title: "LEGO Technic Nike
/// Air Jordan Sneaker Kit" is a LEGO set, "Funko Pop NBA Basketball LeBron" a Funko.
const DOMINANT: &[&str] = &["lego", "funko", "funko pop", "hot wheels", "barbie", "nerf", "play doh", "squishmallow",
    "squishmallows", "hatchimals", "lol surprise", "bobblehead", "action figure", "pokemon card", "diaper bag"];

/// Brands that only make one kind of thing, so the brand alone decides: a DeWalt line is
/// tools whatever else the title lists, a Graco line is baby gear.
const BRAND_CATEGORIES: &[(&str, &[&str])] = &[
    ("Toys", &["fisher price", "vtech", "leapfrog", "melissa and doug", "little tikes", "playmobil",
        "thomas and friends", "magic the gathering", "dungeons and dragons", "hasbro", "mattel"]),
    ("Automotive", &["atv", "utv", "armor all", "meguiars", "chemical guys", "rain x", "turtle wax", "weathertech", "little trees",
        "castrol", "valvoline", "pennzoil", "mobil 1", "prestone", "sea foam", "noco"]),
    ("Baby", &["graco", "chicco", "evenflo", "baby trend", "skip hop", "munchkin", "boppy", "pampers", "huggies",
        "luvs", "dr browns", "philips avent", "tommee tippee", "uppababy", "nuna", "britax", "summer infant"]),
    ("Tools & Hardware", &["dewalt", "milwaukee", "makita", "ryobi", "craftsman", "kobalt", "ridgid", "porter cable",
        "metabo hpt", "irwin", "klein tools"]),
    ("Patio & Garden", &["kingsford", "miracle gro", "scotts", "blackstone", "traeger", "sunnydaze"]),
    ("Grocery", &["gatorade", "coca cola", "pepsi", "kraft", "quaker", "poland spring", "doritos", "cheetos", "oreo",
        "ghirardelli", "hersheys", "frito lay"]),
];

/// Colour names that contain a product word: "Iron Grey" is not an iron, "Football
/// Grey" not a football, "Gum Light Brown" (a sole colour) not chewing gum. A hit inside
/// one of these is dropped.
const COLOURS: &[&str] = &[
    "iron grey", "iron gray", "football grey", "football gray", "gum light brown", "gum medium brown",
    "gum dark brown", "gum yellow", "light gum", "gum sole", "game royal", "gym red", "chocolate brown",
    "honey brown", "coffee brown", "oatmeal heather", "sea salt", "oxford grey", "oxford gray", "oxford blue",
    "cable knit", "chalk white", "sea glass", "silver mirror", "gold mirror", "blue mirror", "mirrored lens",
    "vanilla sugar", "brown sugar", "ladder style", "snack set", "snack stand",
    // Brand and store names.
    "north face", "shoe carnival", "boot barn", "foot locker", "bath and body works", "bed bath and beyond",
    "crate and barrel", "urban outfitters", "body glove", "home depot", "old navy", "radio flyer", "bed head",
    "birds eye", "cast iron", "inch chain", "belt drive", "suction cup", "envelope style", "chisel tip",
    "fine tip", "fine point", "ultra fine", "fragrance free", "pet safe", "under bed", "over sink",
    "over the sink",
    // Condition notes on returns and closeouts.
    "missing charger", "missing parts", "missing part", "missing tool", "missing shelf", "missing accessories",
    "scratch and dent", "open box", "customer return", "damaged box", "no box",
];

/// Words that start a new part of a title: what follows them describes what the product is
/// for or comes with, not what it is ("Backpack **with** Laptop Sleeve", "Case **for** iPad").
const CONNECTORS: &[&str] = &["for", "with", "compatible", "fits", "includes", "including", "featuring"];

/// Words that follow a number as a count ("200 Sheets", "5 Fans") rather than name the product.
const COUNTED: &[&str] = &["sheet", "tablet", "pod", "capsule", "roll", "bag", "pack", "piece", "cup", "fan", "burner"];

/// Containers that are the packaging after a number or a unit ("20 lb Bag", "Family Size Bag").
const PACKAGING: &[&str] = &["bag", "box", "jar", "bottle", "can", "tub", "pouch", "tin", "case"];
const PACK_UNITS: &[&str] = &["lb", "lbs", "oz", "fl", "qt", "gal", "gallon", "ct", "count", "pound", "pounds", "kg", "g",
    "ml", "l", "liter", "litre", "size", "resealable", "bulk", "value", "ft"];

/// Who a product is for, after "for": "Squeaky Toy for Dogs" is a pet supply and
/// "Microfiber Towels for Cars" automotive, whatever the noun is.
const AUDIENCES: &[(&str, &[&str])] = &[
    ("Pet Supplies", &["dog", "dogs", "cat", "cats", "pet", "pets", "puppy", "puppies", "kitten", "kittens"]),
    ("Automotive", &["car", "cars", "truck", "trucks", "vehicle", "vehicles", "suv", "suvs", "auto"]),
    ("Baby", &["baby", "babies", "infant", "infants", "newborn", "newborns"]),
];

/// A title that opens with one of these is a pet supply ("Dog Sweater", "Cat Wand Toy"),
/// unless the next words make it something else ("Cat & Jack", "Cat 6 Cable").
const PET_OPENERS: &[&str] = &["dog", "dogs", "cat", "cats", "puppy", "kitten", "pet", "pets"];
const NOT_PET: &[&str] = &["cat and jack", "cat footwear", "cat eye", "hot dog", "dog days", "cat 5", "cat 6", "cat 7"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Product,
    Context,
    /// A colour name: it names nothing, and removes any hit inside it.
    Colour,
}

struct Phrase {
    words: Vec<String>,
    category: &'static str,
    kind: Kind,
    /// A sneaker model (`SHOE_MODELS`).
    model: bool,
    /// A product that decides the category wherever it sits (`DOMINANT`, `BRAND_CATEGORIES`).
    dominant: bool,
    /// Written with a trailing "!": the word itself only, never its plural ("tablet!" is an
    /// iPad, "tablets" are pills).
    exact: bool,
    /// Position in the lists: on a full tie the phrase listed first wins.
    rank: usize,
}

/// Every phrase, looked up by its first word.
fn index() -> &'static HashMap<String, Vec<Phrase>> {
    static T: OnceLock<HashMap<String, Vec<Phrase>>> = OnceLock::new();
    T.get_or_init(|| {
        let mut lists: Vec<(&'static str, &[&str], Kind, bool)> = vec![("Shoes", SHOE_MODELS, Kind::Product, true)];
        for (cat, products, contexts) in RULES {
            lists.push((cat, products, Kind::Product, false));
            lists.push((cat, contexts, Kind::Context, false));
        }
        lists.push(("", COLOURS, Kind::Colour, false));
        let mut m: HashMap<String, Vec<Phrase>> = HashMap::new();
        let mut rank = 0;
        for (category, list, kind, model) in lists {
            for p in list {
                let exact = p.ends_with('!');
                let words: Vec<String> = p.trim_end_matches('!').split(' ').map(|w| w.to_string()).collect();
                let dominant = DOMINANT.contains(p);
                m.entry(words[0].clone()).or_default().push(Phrase { words, category, kind, model, dominant, exact, rank });
                rank += 1;
            }
        }
        for (category, brands) in BRAND_CATEGORIES {
            for b in *brands {
                let words: Vec<String> = b.split(' ').map(|w| w.to_string()).collect();
                m.entry(words[0].clone()).or_default().push(Phrase {
                    words, category, kind: Kind::Product, model: false, dominant: true, exact: true, rank,
                });
                rank += 1;
            }
        }
        m
    })
}

/// The singular forms a title word may stand for: "shorts" is "shorts" or "short",
/// "batteries" is "battery", "boxes" is "box".
fn singulars(w: &str) -> Vec<String> {
    let mut v = vec![w.to_string()];
    if w.len() > 4 {
        if let Some(s) = w.strip_suffix("ves") {
            v.push(format!("{}f", s));
            v.push(format!("{}fe", s));
        }
    }
    if w.len() > 3 {
        if let Some(s) = w.strip_suffix("ies") {
            v.push(format!("{}y", s));
        }
        if let Some(s) = w.strip_suffix("es") {
            v.push(s.to_string());
        }
    }
    if w.len() > 2 {
        if let Some(s) = w.strip_suffix('s') {
            if !s.ends_with('s') {
                v.push(s.to_string());
            }
        }
    }
    v
}

/// Lowercase words: "&" and "+" read as "and", apostrophes dropped ("Men's" is "mens"),
/// anything else that is not a letter or digit splits words.
fn words(s: &str) -> Vec<String> {
    let t = s.to_lowercase().replace('&', " and ").replace('+', " and ");
    let cleaned: String = t
        .chars()
        .filter(|c| !matches!(c, '\'' | '\u{2019}' | '\u{2018}' | '`' | '®' | '™' | '©'))
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().map(|w| w.to_string()).collect()
}

/// The title cut into parts, in reading order: at commas, brackets, a double quote that
/// is not an inch mark, a quoted colourway ('Shattered Backboard'), a dash with a space
/// either side, and in front of the connector words. Each part is its list of words;
/// parts with no words are dropped.
fn parts(title: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = title.chars().collect();
    let mut raw: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for (i, &c) in chars.iter().enumerate() {
        let prev = if i > 0 { chars[i - 1] } else { ' ' };
        let next = chars.get(i + 1).copied().unwrap_or(' ');
        let cut = match c {
            ',' | ';' | '|' | '(' | ')' | '[' | ']' | '{' | '}' | '\u{201C}' | '\u{201D}' | '\u{2022}' | '\t' => true,
            // 8" is eight inches, not a quote.
            '"' => !prev.is_ascii_digit(),
            '-' | '\u{2013}' | '\u{2014}' | '\u{FFFD}' => prev.is_whitespace() && next.is_whitespace(),
            '\'' | '\u{2018}' | '\u{2019}' => {
                if !in_quote && prev.is_whitespace() && next.is_alphanumeric() {
                    in_quote = true;
                    true
                } else if in_quote && prev.is_alphanumeric() && !next.is_alphanumeric() {
                    in_quote = false;
                    true
                } else {
                    false
                }
            }
            _ => false,
        };
        if cut {
            raw.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    raw.push(cur);
    let mut out: Vec<Vec<String>> = Vec::new();
    for r in raw {
        let mut part: Vec<String> = Vec::new();
        for w in words(&r) {
            // The connector opens the next part, so the pet check can see "for dogs".
            if CONNECTORS.contains(&w.as_str()) && !part.is_empty() {
                out.push(std::mem::take(&mut part));
            }
            part.push(w);
        }
        if !part.is_empty() {
            out.push(part);
        }
    }
    out
}

/// One phrase found in the title.
#[derive(Clone, Copy)]
struct Hit {
    part: usize,
    end: usize,
    len: usize,
    kind: Kind,
    model: bool,
    dominant: bool,
    rank: usize,
    category: &'static str,
}

fn hits(parts: &[Vec<String>]) -> Vec<Hit> {
    let idx = index();
    let mut out = Vec::new();
    for (pi, ws) in parts.iter().enumerate() {
        for start in 0..ws.len() {
            // A one-word phrase is found by any singular of the word; a longer one by its
            // first word exactly, and only its last word may be plural.
            for key in singulars(&ws[start]) {
                let Some(list) = idx.get(&key) else { continue };
                for p in list {
                    let n = p.words.len();
                    let ok = if n == 1 {
                        !p.exact || ws[start] == p.words[0]
                    } else {
                        start + n <= ws.len()
                            && ws[start] == p.words[0]
                            && (1..n - 1).all(|k| ws[start + k] == p.words[k])
                            && if p.exact {
                                ws[start + n - 1] == p.words[n - 1]
                            } else {
                                singulars(&ws[start + n - 1]).iter().any(|s| *s == p.words[n - 1])
                            }
                    };
                    if ok {
                        out.push(Hit {
                            part: pi,
                            end: start + n,
                            len: n,
                            kind: p.kind,
                            model: p.model,
                            dominant: p.dominant,
                            rank: p.rank,
                            category: p.category,
                        });
                    }
                }
            }
        }
    }
    // "200 Sheets", "90 Tablets", "2 Burner": a count, not the product. "20 lb Bag",
    // "Family Size Bag": the packaging. "20V Battery": the tool's battery.
    out.retain(|h| {
        let ws = &parts[h.part];
        if h.len != 1 || h.end < 2 {
            return true;
        }
        let (prev, w) = (ws[h.end - 2].as_str(), ws[h.end - 1].as_str());
        let number = prev.chars().all(|c| c.is_ascii_digit());
        let is = |list: &[&str]| singulars(w).iter().any(|s| list.contains(&s.as_str()));
        // "10 Tablet" is a ten-inch tablet; "90 Tablets" a count.
        let counted = number && is(COUNTED) && w != "tablet";
        let packaging = (number || PACK_UNITS.contains(&prev)) && is(PACKAGING);
        let volts = w.starts_with("batter") && prev.len() > 1 && prev.ends_with('v') && prev[..prev.len() - 1].chars().all(|c| c.is_ascii_digit());
        !(counted || packaging || volts)
    });
    // Nothing inside a colour name counts, and the colour itself names nothing.
    let colours: Vec<Hit> = out.iter().filter(|h| h.kind == Kind::Colour).copied().collect();
    out.retain(|h| {
        h.kind != Kind::Colour
            && !colours.iter().any(|c| c.part == h.part && h.end > c.end - c.len && h.end - h.len < c.end)
    });
    out
}

/// The hit that names the product among `hits`: the earliest part, then products before
/// context, then the phrase ending last, then the longest, then the one listed first.
fn best<'a>(hits: impl Iterator<Item = &'a Hit>) -> Option<&'static str> {
    hits.max_by(|a, b| {
        b.part
            .cmp(&a.part)
            .then((a.kind == Kind::Product).cmp(&(b.kind == Kind::Product)))
            .then(a.end.cmp(&b.end))
            .then(a.len.cmp(&b.len))
            .then(b.rank.cmp(&a.rank))
    })
    .map(|h| h.category)
}

fn is_num(s: &str) -> Option<f64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    s.parse().ok()
}

/// Whole or half, within `lo..=hi`. "010" is a code, not a size.
fn half_size(s: &str, lo: f64, hi: f64) -> bool {
    if s.len() > 1 && s.starts_with('0') && !s.starts_with("0.") {
        return false;
    }
    is_num(s).map_or(false, |v| (lo..=hi).contains(&v) && (v * 2.0).fract() == 0.0)
}

/// Words split on spaces and punctuation but keeping a decimal point ("10.5", "2.5y").
fn size_tokens(title: &str) -> Vec<String> {
    let t: String = title
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '\'' | '\u{2019}'))
        .map(|c| if c.is_alphanumeric() || c == '.' { c } else { ' ' })
        .collect();
    t.split_whitespace().map(|w| w.trim_matches('.').to_string()).filter(|w| !w.is_empty()).collect()
}

/// Brands whose lines are mostly shoes: with one of these, a size number reads as a shoe
/// size ("Vans Authentic Navy 8", "Birkenstock Boston Taupe 39").
const SHOE_BRANDS: &[&str] = &["nike", "jordan", "adidas", "new balance", "nb", "puma", "vans", "converse", "reebok",
    "asics", "hoka", "brooks", "saucony", "skechers", "ugg", "timberland", "dr martens", "birkenstock", "crocs",
    "merrell", "sorel", "fila", "under armour", "ua", "salomon", "keen", "teva", "clarks", "sperry", "cole haan",
    "steve madden", "nine west", "lugz", "k swiss", "mizuno", "altra", "allbirds", "veja", "ecco", "rockport",
    "wolverine", "red wing", "danner", "dansko", "chaco", "olukai", "reef", "havaianas", "minnetonka", "bearpaw",
    "koolaburra", "bogs", "kamik", "stride rite", "heelys", "golden goose", "florsheim", "naturalizer",
    "sam edelman", "franco sarto", "on cloud", "diadora", "karhu", "hey dude", "birkenstocks"];

/// Width letters after a shoe size ("10 D", "9 Wide").
const WIDTHS: &[&str] = &["d", "m", "w", "b", "ee", "2e", "4e", "wide", "narrow", "medium", "xw", "ww"];

/// A shoe brand in the title and a size: a trailing number (optionally with a width), a
/// half size anywhere not followed by a unit, "M9"/"W8.5", or a trailing EU size.
fn shoe_brand_with_size(title: &str) -> bool {
    let ws = words(title);
    let branded = SHOE_BRANDS.iter().any(|b| {
        let bw: Vec<&str> = b.split(' ').collect();
        ws.windows(bw.len()).any(|w| w.iter().zip(&bw).all(|(a, b)| a == b))
    });
    if !branded {
        return false;
    }
    let t = size_tokens(title);
    let unit_after = |i: usize| t.get(i + 1).map_or(false, |u| COUNT_WORDS.contains(&u.as_str()));
    for (i, w) in t.iter().enumerate() {
        if w.ends_with(".5") && half_size(w, 1.0, 16.0) && !unit_after(i) {
            return true;
        }
        if let Some(n) = w.strip_prefix('m').or_else(|| w.strip_prefix('w')) {
            if half_size(n, 1.0, 16.0) {
                return true;
            }
        }
    }
    // A colour or a width may follow the size: "5 White", "10 D".
    let mut end = t.len();
    while end >= 2 && SIZE_LEADS.contains(&t[end - 1].as_str()) && !matches!(t[end - 1].as_str(), "mens" | "womens") {
        end -= 1;
    }
    if end >= 2 && WIDTHS.contains(&t[end - 1].as_str()) && is_num(&t[end - 2]).is_some() {
        end -= 1;
    }
    end >= 2 && t.get(end - 1).map_or(false, |w| half_size(w, 1.0, 16.0) || (!w.contains('.') && half_size(w, 35.0, 48.0)))
}

/// Counts that follow a number without making it a size ("Men's 3 Pack").
const COUNT_WORDS: &[&str] = &["pack", "pk", "ct", "count", "pc", "pcs", "piece", "pieces", "pair", "pairs",
    "set", "oz", "in", "inch", "ft", "lb", "lbs", "qt", "l", "ml", "g", "mm", "cm"];

/// A shoe size in the title: a kids size ("4Y", "12C", "2.5Y"), a kids code ("GS", "PS",
/// "TD", "BG"), a size after "Men's", "Women's", "Size", "US", "M" or "W", or a half size
/// at the end.
fn has_shoe_size(title: &str) -> bool {
    let t = size_tokens(title);
    for (i, w) in t.iter().enumerate() {
        if let Some(n) = w.strip_suffix('y').or_else(|| w.strip_suffix('c')) {
            if half_size(n, 0.0, 13.5) {
                return true;
            }
        }
        if matches!(w.as_str(), "gs" | "ps" | "td" | "bg") {
            return true;
        }
        if matches!(w.as_str(), "mens" | "womens" | "men" | "women" | "wmns" | "size" | "sz" | "us" | "m" | "w" | "talla")
            && t.get(i + 1).map_or(false, |n| half_size(n, 1.0, 16.0))
            && !t.get(i + 2).map_or(false, |u| COUNT_WORDS.contains(&u.as_str()))
        {
            return true;
        }
    }
    t.last().map_or(false, |w| w.contains('.') && half_size(w, 1.0, 16.0))
}

/// A whole number from 1 to 16 at the very end, after a dash or comma ("Shox TL - 10",
/// "Stay Loyal, 15"). Weaker than `has_shoe_size`: it is only believed when nothing else
/// in the title says what it is.
fn ends_in_shoe_size(title: &str) -> bool {
    let t = size_tokens(title);
    let Some(last) = t.last() else { return false };
    if last.contains('.') || !half_size(last, 1.0, 16.0) {
        return false;
    }
    after_separator(title, last)
}

/// Whether the title's last token `last` follows a dash, comma, slash or colon.
fn after_separator(title: &str, last: &str) -> bool {
    let trimmed = title.trim_end().trim_end_matches(|c: char| !c.is_alphanumeric());
    let before = trimmed.get(..trimmed.len().saturating_sub(last.len())).unwrap_or("").trim_end();
    matches!(before.chars().last(), Some('-' | ',' | '/' | ':' | '\u{2013}' | '\u{FFFD}'))
}

const APPAREL_SIZES: &[&str] = &["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "xxxxl", "2xl", "3xl", "4xl", "5xl",
    "1x", "2x", "3x", "4x", "lt", "xlt", "2xlt", "3xlt", "small", "medium", "large", "xlarge", "nb", "2t", "3t", "4t",
    "5t", "3m", "6m", "9m", "12m", "18m", "24m"];

/// Words an apparel size can follow without a dash: "Youth M", "Mens L", "Black M".
const SIZE_LEADS: &[&str] = &["mens", "men", "womens", "women", "wmns", "youth", "kids", "boys", "girls", "toddler",
    "adult", "unisex", "ladies", "black", "white", "grey", "gray", "navy", "blue", "red", "green", "pink", "purple",
    "orange", "yellow", "brown", "tan", "khaki", "olive", "charcoal", "heather", "cream", "beige", "multi", "camo"];

/// An apparel size at the end of the title: "- XL", ", M", "Youth M", "Black 2XL", "3T",
/// "- 12M", or anywhere after "Size" ("Size M"). A lone S, M or L needs a dash, a comma
/// or one of `SIZE_LEADS` in front of it.
fn has_apparel_size(title: &str) -> bool {
    let t = size_tokens(title);
    for (i, w) in t.iter().enumerate() {
        if matches!(w.as_str(), "size" | "sz") && t.get(i + 1).map_or(false, |n| APPAREL_SIZES.contains(&n.as_str())) {
            return true;
        }
    }
    if t.iter().any(|w| {
        let mut it = w.split('x');
        matches!((it.next().and_then(|a| a.parse::<u32>().ok()), it.next().and_then(|b| b.parse::<u32>().ok()), it.next()),
            (Some(a), Some(b), None) if (24..=50).contains(&a) && (24..=38).contains(&b))
    }) {
        return true;
    }
    let Some(last) = t.last() else { return false };
    if !APPAREL_SIZES.contains(&last.as_str()) {
        return false;
    }
    if last.len() >= 2 && !matches!(last.as_str(), "nb" | "lt") {
        return true;
    }
    after_separator(title, last) || (t.len() >= 2 && SIZE_LEADS.contains(&t[t.len() - 2].as_str()))
}

/// A category cell that means "no category": blank, "N/A", "Unknown", "Other", "Misc",
/// "TBD", "-", "?", "nan" (a blank written by pandas). The title guess fills these.
pub(crate) fn is_no_value(s: &str) -> bool {
    const NO_VALUE: &[&str] = &["", "n a", "na", "none", "null", "nan", "unknown", "tbd", "misc", "miscellaneous", "other",
        "others", "uncategorized", "unassigned", "not applicable", "see description", "various", "mixed", "assorted",
        "general", "0", "no category", "not categorized", "unclassified", "blank", "uncategorised", "default", "not specified",
        "unspecified"];
    let w = words(s);
    w.is_empty() || NO_VALUE.contains(&w.join(" ").as_str())
}

/// Whether a single word names a product or a category of them ("shoes", "hoodie",
/// "tablet"), so it is never read as a brand.
pub(crate) fn is_product_word(w: &str) -> bool {
    let idx = index();
    singulars(&w.to_lowercase()).iter().any(|k| idx.get(k).map_or(false, |ps| ps.iter().any(|p| p.words.len() == 1)))
}

/// Whether `ws` holds any of `phrases` as whole words in a row, plurals included.
fn has_phrase(ws: &[String], phrases: &[&str]) -> bool {
    phrases.iter().any(|p| {
        let p: Vec<&str> = p.split(' ').collect();
        ws.windows(p.len()).any(|w| w.iter().zip(&p).all(|(a, b)| singulars(a).iter().any(|s| s == b)))
    })
}

/// The category a title reads as, or "Uncategorized" when nothing in it says.
pub(crate) fn guess_category(title: &str) -> &'static str {
    let ps = parts(title);
    // "for dogs", "for small dogs", "for cars": the audience decides.
    let hs = hits(&ps);
    // "Mixed Pallet of Assorted Household Items", "Liquidation Box Various Items": a lot
    // of mixed goods, whatever goods it names.
    let tw = words(title);
    let lotword = has_phrase(&tw, &["pallet", "lot", "case pack", "assortment", "grab bag", "mystery box", "liquidation box",
        "truckload", "truck load", "salvage", "bulk lot", "return pallet", "returns pallet"]);
    let mixword = has_phrase(&tw, &["mixed", "assorted", "assortment", "various", "variety", "misc", "miscellaneous", "unsorted",
        "general merchandise", "returns", "items", "goods"]);
    if lotword && mixword {
        return "General Merchandise";
    }
    // Babies wear shoes and clothes: "Jordan 1 Low for babies" is still a shoe.
    let worn = hs.iter().any(|h| h.part == 0 && h.kind == Kind::Product && matches!(h.category, "Shoes" | "Clothing" | "Accessories"));
    for p in &ps {
        if p[0] == "for" {
            for (cat, who) in AUDIENCES {
                if (*cat != "Baby" || !worn) && p.iter().skip(1).take(3).any(|w| who.contains(&w.as_str())) {
                    return cat;
                }
            }
        }
    }
    let all = words(title);
    let lead = all.iter().take(3).map(|w| w.as_str()).collect::<Vec<_>>().join(" ");
    if all.first().map_or(false, |w| PET_OPENERS.contains(&w.as_str())) && !NOT_PET.iter().any(|n| lead.starts_with(n)) {
        return "Pet Supplies";
    }
    if let Some(h) = hs.iter().filter(|h| h.dominant).min_by_key(|h| (h.part, h.end)) {
        return h.category;
    }
    // A dose ("200mg", "10000 mcg") is a medicine or a supplement.
    let st = size_tokens(title);
    let dose = |w: &str| {
        ["mg", "mcg", "iu"].iter().any(|u| w.strip_suffix(u).map_or(false, |n| !n.is_empty() && is_num(n).is_some()))
    };
    if st.iter().enumerate().any(|(i, w)| dose(w) || (matches!(w.as_str(), "mg" | "mcg" | "iu") && i > 0 && is_num(&st[i - 1]).is_some())) {
        return "Health & Beauty";
    }
    // 1. A product named in the first part of the title. A sneaker model there is only
    //    outvoted by clothing or an accessory.
    if let Some(c) = best(hs.iter().filter(|h| h.part == 0 && h.kind == Kind::Product)) {
        let model = hs.iter().any(|h| h.part == 0 && h.model);
        return if model && !matches!(c, "Clothing" | "Accessories") { "Shoes" } else { c };
    }
    // 2. A size, before the rest of the title: later parts are mostly colours and sizes,
    //    and a colour can read as a product.
    if has_shoe_size(title) {
        return "Shoes";
    }
    if let Some(c) = best(hs.iter().filter(|h| h.part == 0 && matches!(h.category, "Clothing" | "Accessories"))) {
        return c;
    }
    if shoe_brand_with_size(title) {
        return "Shoes";
    }
    if has_apparel_size(title) {
        return "Clothing";
    }
    // 3. A product anywhere else in the title, then a storage size (a phone, a drive), then
    //    any context word, the earliest part first.
    if let Some(c) = best(hs.iter().filter(|h| h.kind == Kind::Product)) {
        return c;
    }
    if st.iter().any(|w| ["gb", "tb"].iter().any(|u| w.strip_suffix(u).map_or(false, |n| is_num(n).is_some()))) {
        return "Electronics";
    }
    if let Some(c) = best(hs.iter()) {
        return c;
    }
    // 4. A bare trailing number: "Nike Court Royale, White - 10".
    if ends_in_shoe_size(title) {
        return "Shoes";
    }
    UNCATEGORIZED
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn no_phrase_is_listed_twice() {
        let mut seen = HashSet::new();
        let lists = RULES
            .iter()
            .flat_map(|(_, products, contexts)| [*products, *contexts])
            .chain([SHOE_MODELS, COLOURS])
            .chain(BRAND_CATEGORIES.iter().map(|(_, b)| *b));
        for list in lists {
            for p in list {
                let p = &p.trim_end_matches('!');
                assert!(seen.insert(*p), "{p} is listed twice");
                assert_eq!(*p, p.trim().to_lowercase(), "{p} must be lowercase and trimmed");
                assert!(!p.contains("  "), "{p}");
            }
        }
    }

    /// "gummy" in one category and "gummies" in another would make a title's category
    /// depend on list order, since a plural finds both.
    #[test]
    fn no_plural_lands_in_two_categories() {
        let mut cat_of: HashMap<String, &str> = HashMap::new();
        for (cat, products, contexts) in RULES {
            for p in products.iter().chain(contexts.iter()) {
                cat_of.insert(p.trim_end_matches('!').to_string(), cat);
            }
        }
        for (p, cat) in &cat_of {
            let (head, last) = match p.rsplit_once(' ') {
                Some((h, l)) => (format!("{h} "), l),
                None => (String::new(), p.as_str()),
            };
            for s in singulars(last).into_iter().skip(1) {
                if let Some(other) = cat_of.get(&format!("{head}{s}")) {
                    assert_eq!(other, cat, "{p} ({cat}) is a plural of {head}{s} ({other})");
                }
            }
        }
    }

    fn check(cases: &[(&str, &str)]) {
        let wrong: Vec<String> = cases
            .iter()
            .filter(|(t, want)| guess_category(t) != *want)
            .map(|(t, want)| format!("{t:?}: want {want}, got {}", guess_category(t)))
            .collect();
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// The words that fired inside other words under the old substring list.
    #[test]
    fn a_word_never_matches_inside_another() {
        check(&[
            ("Nike Dri-FIT Game Classic 8\" Shorts, University Red, L", "Clothing"),
            ("Air Jordan 1 Retro High OG 'Shattered Backboard' (GS) - 4.5Y", "Shoes"),
            ("Adjustable Standing Desk Converter", "Furniture"),
            ("Breathable Mesh Running Shoes", "Shoes"),
            ("Organic Cotton Clothing Bundle", "Clothing"),
            ("Waterproof Coated Canvas Tote", "Accessories"),
            ("Embedded Wall Outlet, 20 Amp", "Tools & Hardware"),
            ("Pilot G2 Gel Pens, 12 Pack", "Office & School"),
        ]);
    }

    #[test]
    fn the_product_noun_beats_the_words_around_it() {
        check(&[
            ("Shoe Rack, 4-Tier", "Home & Kitchen"),
            ("Laptop Backpack with USB Charging Port", "Accessories"),
            ("Dog Bed, Orthopedic, Large", "Pet Supplies"),
            ("Squeaky Plush Toy for Dogs", "Pet Supplies"),
            ("Kitchen Towel Set of 6", "Home & Kitchen"),
            ("Monopoly Classic Family Board Game", "Toys"),
            ("Jordan AJ1 Men's T-Shirt, Black/White - M", "Clothing"),
            ("Coffee Table with Storage", "Furniture"),
            ("Baby Car Seat Cover", "Automotive"),
            ("Infant Car Seat", "Baby"),
            ("Phone Case for iPhone 15", "Electronics"),
            ("Cat & Jack Girls' Leggings 2pk", "Clothing"),
        ]);
    }

    #[test]
    fn a_sneaker_is_shoes_without_the_word_shoe() {
        check(&[
            ("Nike Force 1 Low / Air Force 1 Low Lace (PS), Triple White, 2.5Y", "Shoes"),
            ("Nike Dunk Low Retro Panda Men's 10.5", "Shoes"),
            ("TD Jordan Flight Club '91 - 10C", "Shoes"),
            ("Nike Offcourt Adjustable-strap Slide 11", "Shoes"),
            ("Air Max 90 - Men's 9", "Shoes"),
            ("Nike Air Max Bolt, Triple White, 9", "Shoes"),
            ("Air Jordan 1 Low G Golf, Wolf Grey / Black - 9.5", "Shoes"),
            ("Jordan 6 Rings TD-10C", "Shoes"),
            ("Nike Quest 6 Black Iron Grey White (Women's) 6", "Shoes"),
            ("Nike Shox TL - 10", "Shoes"),
            ("Nike Court Royale, White/Black - 10", "Shoes"),
            ("Air Jordan Dri-FIT Printed Diamond Shorts 'Light Orewood Brown - L", "Clothing"),
            ("Nike Air Force 1 Keychain", "Accessories"),
        ]);
    }

    #[test]
    fn an_apparel_size_is_clothing_when_nothing_else_says() {
        check(&[
            ("Nike Club Essentials Crew - XL", "Clothing"),
            ("Jordan Essentials Printed Diamond - L", "Clothing"),
            ("Hydro Flask 32", UNCATEGORIZED),
            ("Mystery item 8841", UNCATEGORIZED),
        ]);
    }
}
